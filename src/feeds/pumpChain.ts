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
 */

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOTAL_SUPPLY = 1_000_000_000;
const disc = (name: string) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8).toString('hex');
const TRADE_EVENT = disc('TradeEvent');
const CREATE_EVENT = disc('CreateEvent');

/** Trades for mints the engine hasn't subscribed to yet are kept this long, then replayed on subscribe. */
const BUFFER_MS = 30_000;

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

export class PumpChainFeed extends EventEmitter {
  connected = false;
  lastMessageAt = 0;
  /** Decoded trades across all of pump.fun, subscribed or not — proves the stream is alive. */
  tradesSeen = 0;

  private ws: WebSocket | null = null;
  private subscribed = new Set<string>();
  private books = new Map<string, MintBook>();
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private stopped = false;

  constructor(private readonly url: string) {
    super();
  }

  get subscriptionCount(): number {
    return this.subscribed.size;
  }

  start(): void {
    this.connect();
    this.watchdog = setInterval(() => {
      const now = Date.now();
      if (this.ws && this.connected && now - this.lastMessageAt > 30_000) {
        log.warn('[chain] silent for 30s, forcing reconnect');
        this.ws.terminate();
      }
      for (const [mint, book] of this.books) {
        if (!this.subscribed.has(mint) && now - book.lastSeen > BUFFER_MS) this.books.delete(mint);
      }
    }, 10_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
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

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.lastMessageAt = Date.now();
      log.info(`[chain] connected to ${this.url.replace(/api[-_]key=[^&]+/i, 'api-key=***')}`);
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
      this.lastMessageAt = Date.now();
      const text = raw.toString();
      // Most pump.fun transactions are failed bot spam; skip them before paying for JSON.parse.
      if (!text.includes('"err":null')) {
        if (text.includes('"error"')) log.warn(`[chain] RPC error: ${text.slice(0, 200)}`);
        return;
      }
      this.handle(text);
    });

    ws.on('close', () => {
      this.connected = false;
      if (this.stopped) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(delay * 2, 30_000);
      log.warn(`[chain] disconnected, reconnecting in ${delay}ms`);
      setTimeout(() => this.connect(), delay);
    });

    ws.on('error', (e) => log.warn('[chain] socket error', e));
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
