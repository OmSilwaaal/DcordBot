import fs from 'node:fs';
import { config } from '../config.js';
import type { TokenState } from '../state/tracker.js';
import { dataPath, readJson, writeJsonAtomic } from '../utils/files.js';
import { log } from '../utils/logger.js';
import { PUMP } from './features.js';

/** [positions, wins, pnlSol, quickFlips, snipes, lastAt] — compact, because there are hundreds of thousands. */
type WalletRecord = [number, number, number, number, number, number];

export type WalletClass = 'profitable' | 'flipper' | 'sniper' | 'loser' | null;

export interface WalletProfile {
  positions: number;
  winPct: number;
  pnlSol: number;
  flipPct: number;
  snipePct: number;
  cls: WalletClass;
}

/** Launch-block window for counting a buy as a snipe: 2 blocks is ~1s. */
const SNIPE_SLOTS = 2;
const SNIPE_MS = 3_000;

/**
 * Every wallet's track record on tokens this bot tracked: how many positions, how many
 * made money, total profit, and how it trades (sells within minutes? buys in the launch block?).
 *
 * A position is recorded when its token is dropped from tracking, valuing any tokens still
 * held at the last price. Classification only ever uses positions on tokens that came before,
 * so the features built from it carry no look-ahead.
 *
 * Persisted to data/wallets.json, so it gets more useful the longer the bot runs.
 */
export class WalletBook {
  private wallets = new Map<string, WalletRecord>();
  private dirty = false;

  constructor(
    private readonly cfg = config.walletBook,
    private readonly file = dataPath('wallets.json'),
  ) {
    // A seed (e.g. data/backfill/wallets.json uploaded as wallets-seed.json) replaces the saved book once.
    // It's a separate file because the running bot rewrites wallets.json every few minutes and on shutdown.
    const seed = file.replace(/\.json$/, '-seed.json');
    const source = fs.existsSync(seed) ? seed : this.file;
    for (const [k, v] of readJson<[string, WalletRecord][]>(source, [])) this.wallets.set(k, v);
    if (source === seed) {
      fs.renameSync(seed, seed.replace(/\.json$/, `.applied-${Date.now()}.json`));
      this.dirty = true;
      log.info(`[wallets] loaded seed: ${this.wallets.size} wallets`);
    }
  }

  get size(): number {
    return this.wallets.size;
  }

  profile(wallet: string): WalletProfile | null {
    const r = this.wallets.get(wallet);
    if (!r || r[0] < this.cfg.minPositions) return null;
    const [positions, wins, pnlSol, flips, snipes] = r;
    const winPct = (wins / positions) * 100;
    const flipPct = (flips / positions) * 100;
    const snipePct = (snipes / positions) * 100;
    // Sniping and flipping describe *how* a wallet trades and usually predict a dump, so they take
    // precedence over profitability: an insider sniper is profitable precisely by selling to buyers.
    const c = this.cfg;
    let cls: WalletClass = null;
    if (snipePct >= c.sniperMinPct) cls = 'sniper';
    else if (flipPct >= c.flipperMinPct) cls = 'flipper';
    else if (positions >= c.profitableMinPositions && winPct >= c.profitableMinWinPct && pnlSol >= c.profitableMinPnlSol)
      cls = 'profitable';
    else if (positions >= c.loserMinPositions && winPct < c.loserMaxWinPct && pnlSol < 0) cls = 'loser';
    return { positions, winPct, pnlSol, flipPct, snipePct, cls };
  }

  /** Records every non-dev wallet's position on a token that's leaving tracking. */
  recordToken(s: TokenState, now = Date.now()): void {
    const buyers = s.firstBuyAt.size - (s.firstBuyAt.has(s.creator) ? 1 : 0);
    if (buyers < this.cfg.minTokenBuyers) return;
    const price = s.mcapSol / PUMP.TOTAL_SUPPLY; // SOL per token
    const flipMs = this.cfg.flipSec * 1000;
    for (const [wallet, solIn] of s.walletSolIn) {
      if (wallet === s.creator || solIn < this.cfg.minPositionSol) continue;
      const held = s.balances.get(wallet) ?? 0;
      const pnl = (s.walletSolOut.get(wallet) ?? 0) + held * price - solIn;

      const firstBuy = s.firstBuyAt.get(wallet) ?? 0;
      const firstSell = s.firstSellAt.get(wallet);
      const flipped = firstSell !== undefined && firstSell - firstBuy <= flipMs;
      const slot = s.firstBuySlot.get(wallet);
      const sniped =
        s.createSlot !== null && slot !== undefined ? slot - s.createSlot <= SNIPE_SLOTS : firstBuy - s.createdAt <= SNIPE_MS;

      const r = this.wallets.get(wallet) ?? [0, 0, 0, 0, 0, 0];
      r[0]++;
      if (pnl > 0) r[1]++;
      r[2] = Math.round((r[2] + pnl) * 1e4) / 1e4;
      if (flipped) r[3]++;
      if (sniped) r[4]++;
      r[5] = now;
      this.wallets.set(wallet, r);
    }
    this.dirty = true;
  }

  save(now = Date.now()): void {
    if (!this.dirty) return;
    this.prune(now);
    writeJsonAtomic(this.file, [...this.wallets]);
    this.dirty = false;
  }

  private prune(now: number): void {
    const cutoff = now - this.cfg.keepDays * 86_400_000;
    for (const [k, r] of this.wallets) if (r[5] < cutoff) this.wallets.delete(k);
    const over = this.wallets.size - this.cfg.maxWallets;
    if (over <= 0) return;
    // Drop the least recently active wallets, with some headroom so this doesn't run every save.
    const oldest = [...this.wallets].sort((a, b) => a[1][5] - b[1][5]).slice(0, over + Math.ceil(this.cfg.maxWallets * 0.05));
    for (const [k] of oldest) this.wallets.delete(k);
  }
}
