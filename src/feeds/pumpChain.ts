import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { log } from '../utils/logger.js';
import type { TradeEvent } from '../types.js';

/**
 * pump.fun trades read straight from Solana, as a free replacement for PumpPortal's
 * subscribeTokenTrade (which now needs a funded API key).
 *
 * One logsSubscribe on the pump.fun program delivers every pump.fun transaction; each
 * successful one carries Anchor "Program data:" events. We decode TradeEvent and emit
 * it in the same shape PumpPortal used, for mints the engine has subscribed to.
 *
 * The stream is heavy (~40 MB/min, mostly failed bot transactions), so failed ones are
 * dropped before JSON parsing. Emits: 'trade' (TradeEvent).
 *
 * The public endpoint drops long subscriptions every ~30s. Several staggered sockets
 * run at once and transactions are de-duplicated by signature, so a drop on one socket
 * loses nothing while another is still streaming.
 */

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOTAL_SUPPLY = 1_000_000_000;
const disc = (name: string) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8).toString('hex');
const TRADE_EVENT = disc('TradeEvent');
const CREATE_EVENT = disc('CreateEvent');

/** Trades for mints the engine hasn't subscribed to yet are kept this long, then replayed on subscribe. */
const BUFFER_MS = 30_000;
/** Signatures already handled, kept long enough to cover the slowest socket's lag. */
const SEEN_MS = 60_000;
const SIGNATURE = /"signature":"([1-9A-HJ-NP-Za-km-z]+)"/;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(b: Buffer): string {
  let n = BigInt('0x' + (b.toString('hex') || '0'));
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = '1' + s;
  }
  return s;
}

interface RawTrade {
  mint: string;
  wallet: string;
  isBuy: boolean;
  tokens: number;
  sol: number;
  vTokens: number;
  vSol: number;
  signature: string;
  receivedAt: number;
  /** Dev buy inside the create transaction: PumpPortal's create event already carries it. */
  inCreateTx: boolean;
}

interface MintBook {
  balances: Map<string, number>;
  buffered: RawTrade[];
  lastSeen: number;
}

function decodeTrade(b: Buffer): Omit<RawTrade, 'signature' | 'receivedAt' | 'inCreateTx'> | null {
  // mint, sol_amount, token_amount, is_buy, user, timestamp, virtual_sol_reserves, virtual_token_reserves, …
  if (b.length < 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 + 8) return null;
  let o = 8;
  const mint = base58(b.subarray(o, o + 32));
  o += 32;
  const sol = Number(b.readBigUInt64LE(o)) / 1e9;
  o += 8;
  const tokens = Number(b.readBigUInt64LE(o)) / 1e6;
  o += 8;
  const isBuy = b[o] === 1;
  o += 1;
  const wallet = base58(b.subarray(o, o + 32));
  o += 32 + 8; // skip timestamp
  const vSol = Number(b.readBigUInt64LE(o)) / 1e9;
  o += 8;
  const vTokens = Number(b.readBigUInt64LE(o)) / 1e6;
  return { mint, wallet, isBuy, tokens, sol, vSol, vTokens };
}

/** CreateEvent starts with three strings (name, symbol, uri), then the mint. */
function decodeCreateMint(b: Buffer): string | null {
  let o = 8;
  for (let i = 0; i < 3; i++) {
    if (o + 4 > b.length) return null;
    o += 4 + b.readUInt32LE(o);
  }
  return o + 32 <= b.length ? base58(b.subarray(o, o + 32)) : null;
}

interface Socket {
  id: number;
  ws: WebSocket | null;
  connected: boolean;
  lastMessageAt: number;
  reconnectDelay: number;
}

export class PumpChainFeed extends EventEmitter {
  /** Decoded trades across all of pump.fun, subscribed or not — proves the stream is alive. */
  tradesSeen = 0;
  reconnects = 0;

  private sockets: Socket[] = [];
  private subscribed = new Set<string>();
  private books = new Map<string, MintBook>();
  private seen = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly connections = 3,
  ) {
    super();
  }

  get connected(): boolean {
    return this.sockets.some((s) => s.connected);
  }

  get connectedCount(): number {
    return this.sockets.filter((s) => s.connected).length;
  }

  get lastMessageAt(): number {
    return Math.max(0, ...this.sockets.map((s) => s.lastMessageAt));
  }

  get subscriptionCount(): number {
    return this.subscribed.size;
  }

  start(): void {
    const n = Math.max(1, this.connections);
    for (let i = 0; i < n; i++) {
      const sock: Socket = { id: i + 1, ws: null, connected: false, lastMessageAt: 0, reconnectDelay: 1000 };
      this.sockets.push(sock);
      // Staggered so the public endpoint's ~30s drops don't line up across sockets.
      this.timers.push(setTimeout(() => this.connect(sock), (i * 30_000) / n));
    }
    this.timers.push(
      setInterval(() => {
        const now = Date.now();
        for (const sock of this.sockets) {
          if (sock.ws && sock.connected && now - sock.lastMessageAt > 30_000) {
            log.warn(`[chain#${sock.id}] silent for 30s, forcing reconnect`);
            sock.ws.terminate();
          }
        }
        for (const [mint, book] of this.books) {
          if (!this.subscribed.has(mint) && now - book.lastSeen > BUFFER_MS) this.books.delete(mint);
        }
        for (const [sig, at] of this.seen) {
          if (now - at <= SEEN_MS) break; // insertion order = time order
          this.seen.delete(sig);
        }
      }, 10_000),
    );
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const sock of this.sockets) sock.ws?.close();
  }

  subscribeTrades(mints: string[]): void {
    for (const m of mints) {
      if (this.subscribed.has(m)) continue;
      this.subscribed.add(m);
      const book = this.books.get(m);
      if (!book) continue;
      const pending = book.buffered;
      book.buffered = [];
      for (const t of pending) if (!t.inCreateTx) this.emitTrade(t, book);
    }
  }

  unsubscribeTrades(mints: string[]): void {
    for (const m of mints) {
      this.subscribed.delete(m);
      this.books.delete(m);
    }
  }

  private connect(sock: Socket): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    sock.ws = ws;

    ws.on('open', () => {
      sock.connected = true;
      sock.reconnectDelay = 1000;
      sock.lastMessageAt = Date.now();
      log.info(`[chain#${sock.id}] connected to ${this.url.replace(/api[-_]key=[^&]+/i, 'api-key=***')}`);
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }],
        }),
      );
    });

    ws.on('message', (raw: Buffer) => {
      const now = Date.now();
      sock.lastMessageAt = now;
      const text = raw.toString();
      // Most pump.fun transactions are failed bot spam; skip them before paying for JSON.parse.
      if (!text.includes('"err":null')) {
        if (text.includes('"error"')) log.warn(`[chain#${sock.id}] RPC error: ${text.slice(0, 200)}`);
        return;
      }
      // Every socket sees the same transactions: whichever delivers first wins.
      const sig = SIGNATURE.exec(text)?.[1];
      if (sig) {
        if (this.seen.has(sig)) return;
        this.seen.set(sig, now);
      }
      this.handle(text);
    });

    ws.on('close', () => {
      sock.connected = false;
      if (this.stopped) return;
      this.reconnects++;
      const delay = sock.reconnectDelay;
      sock.reconnectDelay = Math.min(delay * 2, 30_000);
      // The public endpoint's routine drops are expected; only log when the other sockets are down too.
      if (!this.connected) log.warn(`[chain] all sockets down, reconnecting in ${delay}ms`);
      setTimeout(() => this.connect(sock), delay);
    });

    ws.on('error', (e) => {
      if (!/1006/.test(String(e))) log.warn(`[chain#${sock.id}] socket error`, e);
    });
  }

  private handle(text: string): void {
    let value: { signature?: string; logs?: string[] } | undefined;
    try {
      value = JSON.parse(text)?.params?.result?.value;
    } catch {
      return;
    }
    if (!value?.logs) return;
    const now = Date.now();
    const signature = value.signature ?? '';

    const trades: Omit<RawTrade, 'signature' | 'receivedAt' | 'inCreateTx'>[] = [];
    const created = new Set<string>();
    for (const line of value.logs) {
      if (!line.startsWith('Program data: ')) continue;
      const b = Buffer.from(line.slice(14), 'base64');
      const kind = b.subarray(0, 8).toString('hex');
      if (kind === TRADE_EVENT) {
        const t = decodeTrade(b);
        if (t) trades.push(t);
      } else if (kind === CREATE_EVENT) {
        const mint = decodeCreateMint(b);
        if (mint) created.add(mint);
      }
    }

    for (const t of trades) {
      this.tradesSeen++;
      const raw: RawTrade = { ...t, signature, receivedAt: now, inCreateTx: created.has(t.mint) };
      let book = this.books.get(t.mint);
      if (!book) {
        // A mint we've never seen mid-life (e.g. created before we connected) isn't worth buffering.
        if (!raw.inCreateTx && !this.subscribed.has(t.mint)) continue;
        book = { balances: new Map(), buffered: [], lastSeen: now };
        this.books.set(t.mint, book);
      }
      book.lastSeen = now;
      if (this.subscribed.has(t.mint)) {
        if (raw.inCreateTx) this.applyBalance(raw, book);
        else this.emitTrade(raw, book);
      } else {
        // Balances must count every trade from launch, so buffered ones are applied on replay.
        if (raw.inCreateTx) this.applyBalance(raw, book);
        else book.buffered.push(raw);
      }
    }
  }

  /** On-chain events don't carry the trader's balance, so it's tracked from every trade since launch. */
  private applyBalance(t: RawTrade, book: MintBook): number {
    const next = Math.max(0, (book.balances.get(t.wallet) ?? 0) + (t.isBuy ? t.tokens : -t.tokens));
    if (next > 0) book.balances.set(t.wallet, next);
    else book.balances.delete(t.wallet);
    return next;
  }

  private emitTrade(t: RawTrade, book: MintBook): void {
    const ev: TradeEvent = {
      mint: t.mint,
      wallet: t.wallet,
      isBuy: t.isBuy,
      tokens: t.tokens,
      sol: t.sol,
      newBalance: this.applyBalance(t, book),
      vTokens: t.vTokens,
      vSol: t.vSol,
      mcapSol: t.vTokens > 0 ? (t.vSol / t.vTokens) * TOTAL_SUPPLY : 0,
      signature: t.signature,
      receivedAt: t.receivedAt,
    };
    this.emit('trade', ev);
  }
}
