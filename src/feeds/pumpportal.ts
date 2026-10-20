import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { log } from '../utils/logger.js';
import { chunks, num } from '../utils/math.js';
import type { CreateEvent, MigrateEvent, TradeEvent } from '../types.js';
import type { PumpChainFeed } from './pumpChain.js';

/**
 * Single PumpPortal websocket (they ask for one connection per client).
 * Emits: 'create' (CreateEvent), 'trade' (TradeEvent), 'migrate' (MigrateEvent).
 *
 * Subscriptions are batched every 250ms and fully replayed on reconnect, so a
 * dropped socket doesn't silently stop the trade stream for tracked tokens.
 *
 * Trade subscriptions need a funded PumpPortal API key. Without one, pass a
 * PumpChainFeed: launches and migrations still come from here, trades from the chain.
 */
export class PumpPortalFeed extends EventEmitter {
  connected = false;
  messages = 0;

  private ws: WebSocket | null = null;
  private subscribed = new Set<string>();
  private pendingSub = new Set<string>();
  private pendingUnsub = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  lastMessageAt = 0;
  private stopped = false;
  /** PumpPortal sends token amounts in UI units; if they ever arrive raw (6 decimals) we rescale. */
  private tokenScale: number | null = null;
  private notices = new Set<string>();

  constructor(
    private readonly url: string,
    private readonly allowedPools: string[],
    readonly tradeSource: PumpChainFeed | null = null,
  ) {
    super();
  }

  get subscriptionCount(): number {
    if (this.tradeSource) return this.tradeSource.subscriptionCount;
    return this.subscribed.size + this.pendingSub.size;
  }

  start(): void {
    if (this.tradeSource) {
      this.tradeSource.on('trade', (e: TradeEvent) => this.emit('trade', e));
      this.tradeSource.start();
    }
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws && this.connected && Date.now() - this.lastMessageAt > 60_000) {
        log.warn('[pumpportal] silent for 60s, forcing reconnect');
        this.ws.terminate();
      }
    }, 15_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.ws?.close();
    this.tradeSource?.stop();
  }

  subscribeTrades(mints: string[]): void {
    if (this.tradeSource) return this.tradeSource.subscribeTrades(mints);
    for (const m of mints) {
      this.pendingUnsub.delete(m);
      if (!this.subscribed.has(m)) this.pendingSub.add(m);
    }
    this.scheduleFlush();
  }

  unsubscribeTrades(mints: string[]): void {
    if (this.tradeSource) return this.tradeSource.unsubscribeTrades(mints);
    for (const m of mints) {
      this.pendingSub.delete(m);
      if (this.subscribed.has(m)) this.pendingUnsub.add(m);
    }
    this.scheduleFlush();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.lastMessageAt = Date.now();
      log.info('[pumpportal] connected');
      this.send({ method: 'subscribeNewToken' });
      this.send({ method: 'subscribeMigration' });
      // Server-side subscriptions died with the old socket: replay all of them.
      for (const m of this.subscribed) this.pendingSub.add(m);
      this.subscribed.clear();
      this.pendingUnsub.clear();
      this.scheduleFlush(0);
    });

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      this.messages++;
      this.handle(raw.toString());
    });

    ws.on('close', () => {
      this.connected = false;
      if (this.stopped) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(delay * 2, 30_000);
      log.warn(`[pumpportal] disconnected, reconnecting in ${delay}ms`);
      setTimeout(() => this.connect(), delay);
    });

    ws.on('error', (e) => log.warn('[pumpportal] socket error', e));
  }

  private scheduleFlush(delay = 250): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
  }

  private flush(): void {
    if (!this.connected) return; // replayed on 'open'
    if (this.pendingSub.size > 0) {
      const keys = [...this.pendingSub];
      this.pendingSub.clear();
      for (const c of chunks(keys, 100)) this.send({ method: 'subscribeTokenTrade', keys: c });
      for (const k of keys) this.subscribed.add(k);
    }
    if (this.pendingUnsub.size > 0) {
      const keys = [...this.pendingUnsub];
      this.pendingUnsub.clear();
      for (const c of chunks(keys, 100)) this.send({ method: 'unsubscribeTokenTrade', keys: c });
      for (const k of keys) this.subscribed.delete(k);
    }
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private tokens(x: unknown): number {
    return num(x) * (this.tokenScale ?? 1);
  }

  private calibrate(vTokensRaw: unknown): void {
    if (this.tokenScale !== null) return;
    const v = num(vTokensRaw);
    if (v > 0) this.tokenScale = v > 1e12 ? 1e-6 : 1;
  }

  private handle(raw: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (typeof m.mint !== 'string') {
      // Acks are noise, but refusals (e.g. trade subscriptions needing a funded key) must not be silent.
      const text = String(m.message ?? m.errors ?? '');
      if (text && !/^successfully/i.test(text) && !this.notices.has(text)) {
        this.notices.add(text);
        log.warn(`[pumpportal] ${text}`);
      }
      return;
    }
    const now = Date.now();
    const pool = typeof m.pool === 'string' ? m.pool : 'pump';
    this.calibrate(m.vTokensInBondingCurve);

    switch (m.txType) {
      case 'create': {
        if (!this.allowedPools.includes(pool)) return;
        const ev: CreateEvent = {
          mint: m.mint,
          name: String(m.name ?? '').slice(0, 64),
          symbol: String(m.symbol ?? '').slice(0, 32),
          uri: String(m.uri ?? ''),
          creator: String(m.traderPublicKey ?? ''),
          bondingCurveKey: String(m.bondingCurveKey ?? ''),
          pool,
          initialBuyTokens: this.tokens(m.initialBuy),
          initialBuySol: num(m.solAmount),
          vTokens: this.tokens(m.vTokensInBondingCurve),
          vSol: num(m.vSolInBondingCurve),
          mcapSol: num(m.marketCapSol),
          signature: String(m.signature ?? ''),
          receivedAt: now,
        };
        this.emit('create', ev);
        return;
      }
      case 'buy':
      case 'sell': {
        const ev: TradeEvent = {
          mint: m.mint,
          wallet: String(m.traderPublicKey ?? ''),
          isBuy: m.txType === 'buy',
          tokens: this.tokens(m.tokenAmount),
          sol: num(m.solAmount),
          newBalance: this.tokens(m.newTokenBalance),
          vTokens: this.tokens(m.vTokensInBondingCurve),
          vSol: num(m.vSolInBondingCurve),
          mcapSol: num(m.marketCapSol),
          signature: String(m.signature ?? ''),
          receivedAt: now,
        };
        this.emit('trade', ev);
        return;
      }
      case 'migrate': {
        const ev: MigrateEvent = { mint: m.mint, pool, signature: String(m.signature ?? ''), receivedAt: now };
        this.emit('migrate', ev);
        return;
      }
    }
  }
}
