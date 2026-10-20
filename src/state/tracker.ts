import type { CreateEvent, Features, TokenMetadata, TradeEvent } from '../types.js';

export interface Trade {
  ts: number;
  wallet: string;
  isBuy: boolean;
  sol: number;
}

export type TokenStatus = 'watching' | 'verifying' | 'signaled' | 'rejected';

/**
 * Feature snapshot taken at a fixed age for EVERY tracked token (not just signals),
 * labelled afterwards with what price did next. This is the unbiased dataset the
 * analyze tool uses to find which features actually predict outcomes.
 */
export interface Snapshot {
  ageSec: number;
  takenAt: number;
  mcapSol: number;
  features: Features;
  peakMult: number;
  troughMult: number;
  /** Which plan threshold was hit first after the snapshot. */
  first: 'tp' | 'sl' | null;
}

const TRADE_RETENTION_MS = 10 * 60_000;
const MAX_TRADES = 5000;

export class TokenState {
  readonly mint: string;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly creator: string;
  readonly bondingCurveKey: string;
  readonly createdAt: number;
  readonly tickerDupes: number;

  trades: Trade[] = [];
  /** Latest known balance per wallet (from newTokenBalance). Curve account never trades, so it's excluded by construction. */
  balances = new Map<string, number>();
  firstBuyAt = new Map<string, number>();
  walletVol = new Map<string, number>();
  walletBuys = new Map<string, number>();
  walletSells = new Map<string, number>();
  totalVolSol = 0;
  devPeak = 0;

  vTokens: number;
  vSol: number;
  mcapSol: number;
  peakMcapSol: number;
  lastTradeAt: number;
  tradeCount = 0;

  dirty = true;
  lastEvalAt = 0;
  status: TokenStatus = 'watching';
  rejectReason: string | null = null;
  waitReason: string | null = null;
  /** Last reason the verify stage held this token back (on-chain, RugCheck, cap…). */
  verifyNote: string | null = null;
  /** Funnel accounting: fewest gates this token ever failed at once, which ones, and best score once through. */
  bestFailCount = Infinity;
  bestFailKeys: string[] = [];
  bestScore = 0;
  reachedVerify = false;
  nextVerifyAt = 0;
  verifyFailures = 0;
  graduated = false;
  metadata: TokenMetadata | null | undefined = undefined; // undefined = not fetched yet
  snapshots: Snapshot[] = [];
  snapshotAgesTaken = new Set<number>();

  constructor(e: CreateEvent, tickerDupes: number) {
    this.mint = e.mint;
    this.name = e.name;
    this.symbol = e.symbol;
    this.uri = e.uri;
    this.creator = e.creator;
    this.bondingCurveKey = e.bondingCurveKey;
    this.createdAt = e.receivedAt;
    this.tickerDupes = tickerDupes;
    this.vTokens = e.vTokens;
    this.vSol = e.vSol;
    this.mcapSol = e.mcapSol;
    this.peakMcapSol = e.mcapSol;
    this.lastTradeAt = e.receivedAt;

    if (e.initialBuyTokens > 0 && e.creator) {
      this.balances.set(e.creator, e.initialBuyTokens);
      this.firstBuyAt.set(e.creator, e.receivedAt);
      this.walletVol.set(e.creator, e.initialBuySol);
      this.walletBuys.set(e.creator, 1);
      this.totalVolSol += e.initialBuySol;
      this.devPeak = e.initialBuyTokens;
      this.trades.push({ ts: e.receivedAt, wallet: e.creator, isBuy: true, sol: e.initialBuySol });
    }
  }

  applyTrade(t: TradeEvent, plan: { takeProfitMult: number; stopLossPct: number }): void {
    const ts = t.receivedAt;
    this.trades.push({ ts, wallet: t.wallet, isBuy: t.isBuy, sol: t.sol });
    this.pruneTrades(ts);

    if (t.newBalance > 0) this.balances.set(t.wallet, t.newBalance);
    else this.balances.delete(t.wallet);

    if (t.isBuy) {
      if (!this.firstBuyAt.has(t.wallet)) this.firstBuyAt.set(t.wallet, ts);
      this.walletBuys.set(t.wallet, (this.walletBuys.get(t.wallet) ?? 0) + 1);
    } else {
      this.walletSells.set(t.wallet, (this.walletSells.get(t.wallet) ?? 0) + 1);
    }
    this.walletVol.set(t.wallet, (this.walletVol.get(t.wallet) ?? 0) + t.sol);
    this.totalVolSol += t.sol;

    if (t.wallet === this.creator) this.devPeak = Math.max(this.devPeak, t.newBalance);
    if (t.vTokens > 0) this.vTokens = t.vTokens;
    if (t.vSol > 0) this.vSol = t.vSol;
    if (t.mcapSol > 0) {
      this.mcapSol = t.mcapSol;
      if (t.mcapSol > this.peakMcapSol) this.peakMcapSol = t.mcapSol;
      this.updateSnapshots(plan);
    }

    this.lastTradeAt = ts;
    this.tradeCount++;
    this.dirty = true;
  }

  private updateSnapshots(plan: { takeProfitMult: number; stopLossPct: number }): void {
    const slMult = 1 - plan.stopLossPct / 100;
    for (const s of this.snapshots) {
      const m = this.mcapSol / s.mcapSol;
      if (m > s.peakMult) s.peakMult = m;
      if (m < s.troughMult) s.troughMult = m;
      if (s.first === null) {
        if (m >= plan.takeProfitMult) s.first = 'tp';
        else if (m <= slMult) s.first = 'sl';
      }
    }
  }

  private pruneTrades(now: number): void {
    const cutoff = now - TRADE_RETENTION_MS;
    let i = 0;
    while (i < this.trades.length && this.trades[i].ts < cutoff) i++;
    if (this.trades.length - i > MAX_TRADES) i = this.trades.length - MAX_TRADES;
    if (i > 0) this.trades.splice(0, i);
  }
}

export class Tracker {
  readonly tokens = new Map<string, TokenState>();
  private tickerLog = new Map<string, number[]>();

  constructor(private readonly tickerWindowMs: number) {}

  get size(): number {
    return this.tokens.size;
  }

  /** Counts same-ticker launches in the window *before* this one: the first launch of a ticker gets 0. */
  create(e: CreateEvent): TokenState {
    const key = e.symbol.trim().toUpperCase();
    const recent = (this.tickerLog.get(key) ?? []).filter((t) => e.receivedAt - t < this.tickerWindowMs);
    const state = new TokenState(e, recent.length);
    recent.push(e.receivedAt);
    this.tickerLog.set(key, recent);
    this.tokens.set(e.mint, state);
    return state;
  }

  get(mint: string): TokenState | undefined {
    return this.tokens.get(mint);
  }

  remove(mint: string): void {
    this.tokens.delete(mint);
  }

  pruneTickerLog(now: number): void {
    for (const [k, ts] of this.tickerLog) {
      const keep = ts.filter((t) => now - t < this.tickerWindowMs);
      if (keep.length === 0) this.tickerLog.delete(k);
      else this.tickerLog.set(k, keep);
    }
  }
}
