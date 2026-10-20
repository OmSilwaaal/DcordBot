import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { computeFeatures } from '../analysis/features.js';
import { checkGates } from '../analysis/gates.js';
import { fetchMetadata } from '../analysis/metadata.js';
import { onchainCheck } from '../analysis/onchain.js';
import { rugcheck } from '../analysis/rugcheck.js';
import { computeScore, SOCIAL_MAX } from '../analysis/score.js';
import { getMarketCaps } from '../feeds/dexscreener.js';
import type { PumpPortalFeed } from '../feeds/pumpportal.js';
import type { SolPriceFeed } from '../feeds/solPrice.js';
import { Tracker, type TokenState } from '../state/tracker.js';
import type { CreateEvent, Features, MigrateEvent, SignalRecord, TradeEvent } from '../types.js';
import { appendJsonl, dailyFile } from '../utils/files.js';
import { log } from '../utils/logger.js';
import { newPerfState, type PerformanceTracker } from './performance.js';

export interface Notifier {
  sendSignal(r: SignalRecord): Promise<string | null>;
  updateSignal(r: SignalRecord): Promise<void>;
}

/**
 * Pipeline per token:
 *   create → subscribe trades → (every trade) recompute features
 *   → hard gates → score → verify (metadata, on-chain, RugCheck)
 *   → recompute against latest state → signal → forward-test outcome.
 *
 * Emits 'signal' (SignalRecord) — the hook for an execution module later.
 */
export class SignalEngine extends EventEmitter {
  readonly tracker = new Tracker(config.tracking.tickerWindowMin * 60_000);
  readonly stats = { created: 0, trades: 0, evaluated: 0, verified: 0, signals: 0, rejected: 0, dropped: 0 };

  readonly startedAt = Date.now();
  /** Launch timestamps from the last 5 minutes (for /status). */
  private recentCreates: number[] = [];
  private ticking = false;
  private verifying = new Set<string>();
  private sentTimes: number[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly feed: PumpPortalFeed,
    private readonly sol: SolPriceFeed,
    private readonly perf: PerformanceTracker,
    private readonly notifier: Notifier,
  ) {
    super();
  }

  start(): void {
    this.feed.on('create', (e: CreateEvent) => this.onCreate(e));
    this.feed.on('trade', (e: TradeEvent) => this.onTrade(e));
    this.feed.on('migrate', (e: MigrateEvent) => this.onMigrate(e));
    this.perf.on('finalized', (r: SignalRecord) => {
      if (!this.tracker.get(r.mint)) this.feed.unsubscribeTrades([r.mint]);
    });

    // Signals still being forward-tested from before a restart keep their price stream.
    if (this.perf.mints().length) this.feed.subscribeTrades(this.perf.mints());

    const every = (ms: number, fn: () => void) => this.timers.push(setInterval(fn, ms));
    every(config.tracking.evalIntervalMs, () => this.tick());
    every(15_000, () => this.prune());
    every(15_000, () => this.perf.tick(Date.now()));
    every(30_000, () => this.perf.save());
    every(60_000, () => void this.pollOutcomes());
    every(60_000, () => this.logStatus());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }

  launchesLast5m(now = Date.now()): number {
    this.recentCreates = this.recentCreates.filter((t) => now - t < 300_000);
    return this.recentCreates.length;
  }

  /** Newest token old enough to exist on-chain — used by /status to exercise the RPC + RugCheck path for real. */
  probeToken(now = Date.now()): TokenState | undefined {
    let best: TokenState | undefined;
    for (const s of this.tracker.tokens.values()) {
      const age = now - s.createdAt;
      if (age < 30_000 || age > 15 * 60_000) continue;
      if (!best || s.createdAt > best.createdAt) best = s;
    }
    return best;
  }

  /** Closest-to-signaling tokens right now, with the reason each one is still waiting. */
  topCandidates(n = 5, now = Date.now()) {
    const rows: { symbol: string; mint: string; score: number; f: Features; reason: string }[] = [];
    for (const s of this.tracker.tokens.values()) {
      if (s.status !== 'watching' && s.status !== 'verifying') continue;
      const f = computeFeatures(s, now, this.sol.value, config.tracking.sniperWindowSec);
      const gate = checkGates(f);
      const score = computeScore(f, s.metadata ?? null).total;
      const reason =
        s.status === 'verifying' ? 'verifying now' : gate.pass ? (s.waitReason ?? 'passes gates') : gate.reason;
      rows.push({ symbol: s.symbol, mint: s.mint, score, f, reason });
    }
    return rows.sort((a, b) => b.score - a.score).slice(0, n);
  }

  // ── Feed handlers ────────────────────────────────────────────────────

  private onCreate(e: CreateEvent): void {
    if (this.tracker.get(e.mint)) return;
    const s = this.tracker.create(e);
    this.stats.created++;
    this.recentCreates.push(e.receivedAt);
    if (this.recentCreates.length > 5000) this.recentCreates.splice(0, this.recentCreates.length - 5000);
    if (s.tickerDupes > config.gates.maxTickerDupes) {
      this.tracker.remove(e.mint); // copycat: don't spend a subscription on it
      return;
    }
    this.feed.subscribeTrades([e.mint]);
  }

  private onTrade(t: TradeEvent): void {
    this.stats.trades++;
    const s = this.tracker.get(t.mint);
    if (s) s.applyTrade(t, config.plan);
    if (this.perf.active.has(t.mint) && this.sol.value && t.mcapSol > 0) {
      this.perf.onPrice(t.mint, t.mcapSol * this.sol.value, t.receivedAt);
    }
  }

  private onMigrate(e: MigrateEvent): void {
    const s = this.tracker.get(e.mint);
    if (s) s.graduated = true;
    this.perf.markGraduated(e.mint);
  }

  // ── Evaluation loop ──────────────────────────────────────────────────

  private tick(): void {
    if (this.ticking) return; // never overlap (original bug: setInterval with async body)
    this.ticking = true;
    try {
      const now = Date.now();
      for (const s of this.tracker.tokens.values()) {
        const snapAge = this.snapshotDue(s, now);
        const needsEval =
          s.status === 'watching' &&
          now >= s.nextVerifyAt &&
          (s.dirty || now - s.lastEvalAt >= 10_000);
        if (snapAge === null && !needsEval) continue;

        const f = computeFeatures(s, now, this.sol.value, config.tracking.sniperWindowSec);
        if (snapAge !== null) this.takeSnapshot(s, snapAge, f, now);
        if (!needsEval) continue;

        s.dirty = false;
        s.lastEvalAt = now;
        this.stats.evaluated++;

        const gate = checkGates(f);
        if (!gate.pass) {
          if (gate.permanent) this.reject(s, gate.reason);
          else s.waitReason = gate.reason;
          continue;
        }

        const score = computeScore(f, s.metadata ?? null);
        const slack = s.metadata === undefined ? SOCIAL_MAX : 0; // socials not fetched yet
        if (score.total + slack < config.scoring.minScore) {
          s.waitReason = `score ${score.total} < ${config.scoring.minScore}`;
          continue;
        }

        if (this.verifying.size >= config.tracking.verifyConcurrency) {
          s.dirty = true; // pick it up next tick
          continue;
        }
        s.status = 'verifying';
        this.verifying.add(s.mint);
        void this.verify(s).finally(() => this.verifying.delete(s.mint));
      }
    } finally {
      this.ticking = false;
    }
  }

  private async verify(s: TokenState): Promise<void> {
    const g = config.gates;
    this.stats.verified++;
    try {
      if (s.metadata === undefined) s.metadata = await fetchMetadata(s.uri);

      const oc = await onchainCheck(s.mint, s.bondingCurveKey);
      if (oc.ok) {
        if (oc.mintAuthority) return this.reject(s, 'mint authority not revoked');
        if (oc.freezeAuthority) return this.reject(s, 'freeze authority not revoked');
        if (oc.dangerousExtensions.length) return this.reject(s, `token-2022: ${oc.dangerousExtensions.join(', ')}`);
        if (oc.top10Pct > g.onchainMaxTop10Pct) return this.retryLater(s, `on-chain top10 ${oc.top10Pct.toFixed(1)}%`);
        if (oc.maxHolderPct > g.onchainMaxSingleHolderPct)
          return this.retryLater(s, `on-chain max holder ${oc.maxHolderPct.toFixed(1)}%`);
      } else if (g.requireOnchain) {
        return this.retryLater(s, `on-chain check failed: ${oc.error}`);
      }

      const rc = await rugcheck(s.mint);
      if (rc.status === 'ok' && rc.dangers.length) return this.reject(s, `rugcheck: ${rc.dangers.join(', ')}`);
      if (rc.status !== 'ok' && g.requireRugcheck) return this.retryLater(s, `rugcheck ${rc.status}`);

      // The awaits above took time and trades kept coming: re-decide on fresh state.
      const now = Date.now();
      const f = computeFeatures(s, now, this.sol.value, config.tracking.sniperWindowSec);
      const gate = checkGates(f);
      if (!gate.pass) {
        if (gate.permanent) return this.reject(s, gate.reason);
        s.status = 'watching';
        s.waitReason = gate.reason;
        return;
      }
      const score = computeScore(f, s.metadata ?? null);
      if (score.total < config.scoring.minScore) {
        s.status = 'watching';
        s.waitReason = `score ${score.total} after verify`;
        return;
      }
      if (!this.sol.value) return this.retryLater(s, 'no SOL price yet');
      if (!this.underHourlyCap(now)) return this.retryLater(s, 'hourly signal cap');

      await this.emitSignal(s, f, score, oc.ok ? oc : null, rc, now);
    } catch (e) {
      log.error(`[engine] verify ${s.symbol} failed`, e);
      this.retryLater(s, 'verify error');
    }
  }

  private async emitSignal(
    s: TokenState,
    f: Features,
    score: ReturnType<typeof computeScore>,
    onchain: SignalRecord['onchain'],
    rc: SignalRecord['rugcheck'],
    now: number,
  ): Promise<void> {
    const solUsd = this.sol.value!;
    s.status = 'signaled';
    const rec: SignalRecord = {
      id: `${s.mint.slice(0, 6)}-${now}`,
      mint: s.mint,
      symbol: s.symbol,
      name: s.name,
      signaledAt: now,
      score: score.total,
      tier: score.tier,
      parts: score.parts,
      features: f,
      onchain,
      rugcheck: rc,
      socials: s.metadata ?? null,
      entryMcapUsd: s.mcapSol * solUsd,
      solPriceAtSignal: solUsd,
      perf: newPerfState(),
    };
    this.perf.add(rec);
    this.sentTimes.push(now);
    this.stats.signals++;
    log.info(`🚀 SIGNAL tier ${rec.tier} $${s.symbol} score=${rec.score} mcap=$${Math.round(rec.entryMcapUsd)} ${s.mint}`);
    this.emit('signal', rec);

    const messageId = await this.notifier.sendSignal(rec).catch((e) => {
      log.error('[engine] discord send failed', e);
      return null;
    });
    if (messageId) {
      rec.messageId = messageId;
      this.perf.markDirty();
    }
  }

  private reject(s: TokenState, reason: string): void {
    s.status = 'rejected';
    s.rejectReason = reason;
    this.stats.rejected++;
    log.debug(`[engine] ✗ $${s.symbol} ${reason}`);
  }

  private retryLater(s: TokenState, reason: string): void {
    s.status = 'watching';
    s.waitReason = reason;
    s.verifyFailures++;
    s.nextVerifyAt = Date.now() + Math.min(60_000, 5_000 * 2 ** (s.verifyFailures - 1));
    log.debug(`[engine] … $${s.symbol} ${reason}`);
  }

  private underHourlyCap(now: number): boolean {
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3_600_000);
    return this.sentTimes.length < config.limits.maxSignalsPerHour;
  }

  // ── Dataset snapshots ────────────────────────────────────────────────

  private snapshotDue(s: TokenState, now: number): number | null {
    if (!config.dataset.enabled) return null;
    const age = (now - s.createdAt) / 1000;
    for (const a of config.dataset.snapshotAgesSec) {
      if (!s.snapshotAgesTaken.has(a) && age >= a) return a;
    }
    return null;
  }

  private takeSnapshot(s: TokenState, ageSec: number, f: Features, now: number): void {
    s.snapshotAgesTaken.add(ageSec);
    // Late by >30s (e.g. the loop was busy) → skip rather than mislabel the age.
    if (f.ageSec - ageSec > 30 || !(s.mcapSol > 0)) return;
    s.snapshots.push({ ageSec, takenAt: now, mcapSol: s.mcapSol, features: f, peakMult: 1, troughMult: 1, first: null });
  }

  // ── Housekeeping ─────────────────────────────────────────────────────

  private prune(): void {
    const now = Date.now();
    const t = config.tracking;
    for (const s of [...this.tracker.tokens.values()]) {
      const age = now - s.createdAt;
      let reason: string | null = null;
      if (s.status === 'signaled') {
        if (!this.perf.active.has(s.mint)) reason = 'forward test done';
      } else if (s.status === 'verifying') {
        continue;
      } else if (age > t.watchWindowMin * 60_000) {
        reason = 'watch window ended';
      } else if (age > 120_000 && now - s.lastTradeAt > t.deadAfterSec * 1000) {
        reason = 'no trades';
      }
      if (reason) this.drop(s, reason);
    }

    if (this.tracker.size > t.maxTracked) {
      const evictable = [...this.tracker.tokens.values()]
        .filter((s) => s.status === 'watching' || s.status === 'rejected')
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const s of evictable.slice(0, this.tracker.size - t.maxTracked)) this.drop(s, 'capacity');
    }
    this.tracker.pruneTickerLog(now);
  }

  private drop(s: TokenState, reason: string): void {
    if (config.dataset.enabled && s.snapshots.length) {
      appendJsonl(dailyFile('dataset'), {
        mint: s.mint,
        symbol: s.symbol,
        createdAt: s.createdAt,
        droppedAt: Date.now(),
        dropReason: reason,
        status: s.status,
        rejectReason: s.rejectReason,
        graduated: s.graduated,
        peakMcapSol: s.peakMcapSol,
        lastMcapSol: s.mcapSol,
        snapshots: s.snapshots,
      });
    }
    if (!this.perf.active.has(s.mint)) this.feed.unsubscribeTrades([s.mint]);
    this.tracker.remove(s.mint);
    this.stats.dropped++;
  }

  /** DexScreener fallback for signals whose stream went quiet (e.g. after graduating off the curve). */
  private async pollOutcomes(): Promise<void> {
    const now = Date.now();
    const stale = [...this.perf.active.values()].filter((r) => now - r.perf.lastUpdate > 90_000).map((r) => r.mint);
    if (!stale.length) return;
    try {
      const caps = await getMarketCaps(stale);
      for (const [mint, mc] of caps) this.perf.onPrice(mint, mc, Date.now());
    } catch (e) {
      log.warn('[engine] outcome poll failed', e);
    }
  }

  private logStatus(): void {
    const st = this.stats;
    log.info(
      `[status] tracked=${this.tracker.size} subs=${this.feed.subscriptionCount} ws=${this.feed.connected ? 'up' : 'DOWN'} ` +
        `created=${st.created} trades=${st.trades} evals=${st.evaluated} verified=${st.verified} ` +
        `signals=${st.signals} rejected=${st.rejected} forwardTesting=${this.perf.active.size} sol=$${this.sol.value?.toFixed(2) ?? '?'}`,
    );
  }
}
