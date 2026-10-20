import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { CreatorBook } from '../analysis/creators.js';
import { dexOrders } from '../analysis/dexOrders.js';
import { computeFeatures, type FeatureContext } from '../analysis/features.js';
import { analyzeWallets } from '../analysis/wallets.js';
import { xMentions } from '../analysis/xMentions.js';
import { checkGates, failingGates } from '../analysis/gates.js';
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
  /** Since boot: tokens that reached min age, how close each got, and where the verify stage stopped them. */
  readonly funnel = {
    matured: 0,
    passedGates: 0,
    scoreBlocked: 0,
    nearMiss: new Map<string, number>(), // gate key → tokens whose ONLY failing gate was this one
    verifyOutcomes: new Map<string, number>(),
    permanentRejects: new Map<string, number>(),
  };
  /** Launch timestamps from the last 5 minutes (for /status). */
  private recentCreates: number[] = [];
  private recentGraduations: number[] = [];
  readonly creators = new CreatorBook();
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
    every(60_000, () => this.creators.save());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.creators.save();
  }

  launchesLast5m(now = Date.now()): number {
    this.recentCreates = this.recentCreates.filter((t) => now - t < 600_000);
    return this.recentCreates.filter((t) => now - t < 300_000).length;
  }

  /** Shared inputs for feature computation: creator history + market conditions. */
  featureContext(now = Date.now()): FeatureContext {
    this.recentCreates = this.recentCreates.filter((t) => now - t < 600_000);
    this.recentGraduations = this.recentGraduations.filter((t) => now - t < 3_600_000);
    const uptimeMin = Math.max(1, Math.min(10, (now - this.startedAt) / 60_000));
    return {
      solUsd: this.sol.value,
      sniperWindowSec: config.tracking.sniperWindowSec,
      creator: (c, ts) => this.creators.stats(c, ts),
      market: {
        launchesPerMin: this.recentCreates.length / uptimeMin,
        graduations1h: this.recentGraduations.length,
        solChange1hPct: this.sol.change1hPct(),
      },
    };
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
    const ctx = this.featureContext(now);
    const rows: { symbol: string; mint: string; score: number; f: Features; reason: string }[] = [];
    for (const s of this.tracker.tokens.values()) {
      if (s.status !== 'watching' && s.status !== 'verifying') continue;
      const f = computeFeatures(s, now, ctx);
      const gate = checkGates(f);
      const score = computeScore(f, s.metadata ?? null).total;
      const reason =
        s.status === 'verifying'
          ? 'verifying now'
          : !gate.pass
            ? gate.reason
            : score < config.scoring.minScore
              ? `score ${score} < ${config.scoring.minScore}`
              : s.verifyNote
                ? `held at verify: ${s.verifyNote}`
                : 'passes — queued for verify';
      rows.push({ symbol: s.symbol, mint: s.mint, score, f, reason });
    }
    return rows.sort((a, b) => b.score - a.score).slice(0, n);
  }

  // ── Feed handlers ────────────────────────────────────────────────────

  private onCreate(e: CreateEvent): void {
    if (this.tracker.get(e.mint)) return;
    const s = this.tracker.create(e);
    this.stats.created++;
    this.creators.recordLaunch(e.creator, e.mint, e.receivedAt);
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
    this.recentGraduations.push(e.receivedAt);
    this.creators.recordGraduation(e.mint);
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
      const ctx = this.featureContext(now);
      for (const s of this.tracker.tokens.values()) {
        const snapAge = this.snapshotDue(s, now);
        const needsEval =
          s.status === 'watching' &&
          now >= s.nextVerifyAt &&
          (s.dirty || now - s.lastEvalAt >= 10_000);
        if (snapAge === null && !needsEval) continue;

        const f = computeFeatures(s, now, ctx);
        if (snapAge !== null) this.takeSnapshot(s, snapAge, f, now);
        if (!needsEval) continue;

        s.dirty = false;
        s.lastEvalAt = now;
        this.stats.evaluated++;

        if (f.ageSec >= config.gates.minAgeSec) {
          const fails = failingGates(f);
          if (fails.length < s.bestFailCount) {
            s.bestFailCount = fails.length;
            s.bestFailKeys = fails;
          }
        }

        const gate = checkGates(f);
        if (!gate.pass) {
          if (gate.permanent) this.reject(s, gate.reason);
          else s.waitReason = gate.reason;
          continue;
        }

        const score = computeScore(f, s.metadata ?? null);
        if (score.total > s.bestScore) s.bestScore = score.total;
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
        s.waitReason = null;
        s.reachedVerify = true;
        this.verifying.add(s.mint);
        void this.verify(s).finally(() => this.verifying.delete(s.mint));
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Top holders + earliest buyers (dev excluded): the wallets that decide whether "unique buyers" is real. */
  private walletSample(s: TokenState): string[] {
    const n = config.wallets.sample;
    const top = [...s.balances.entries()]
      .filter(([w]) => w !== s.creator)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.ceil(n / 2))
      .map(([w]) => w);
    const early = [...s.firstBuyAt.entries()]
      .filter(([w]) => w !== s.creator)
      .sort((a, b) => a[1] - b[1])
      .map(([w]) => w);
    const out = new Set(top);
    for (const w of early) {
      if (out.size >= n) break;
      out.add(w);
    }
    return [...out];
  }

  private async verify(s: TokenState): Promise<void> {
    const g = config.gates;
    this.stats.verified++;
    try {
      // Phase 1 — safety checks that can kill the token (run in parallel).
      const [meta, oc, rc] = await Promise.all([
        s.metadata === undefined ? fetchMetadata(s.uri) : Promise.resolve(s.metadata),
        onchainCheck(s.mint, s.bondingCurveKey),
        rugcheck(s.mint),
      ]);
      s.metadata = meta;

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
      if (rc.status === 'ok' && rc.dangers.length) return this.reject(s, `rugcheck: ${rc.dangers.join(', ')}`);
      if (rc.status !== 'ok' && g.requireRugcheck) return this.retryLater(s, `rugcheck ${rc.status}`);

      // Phase 2 — enrichment, only for tokens that survived phase 1 (saves RPC credits and X budget).
      const [wallets, orders, x] = await Promise.all([
        config.wallets.enabled
          ? analyzeWallets(s.mint, this.walletSample(s), s.creator, s.balances)
          : Promise.resolve(null),
        config.dexOrders.enabled ? dexOrders(s.mint, s.createdAt) : Promise.resolve(null),
        xMentions(s.mint),
      ]);

      if (wallets?.ok) {
        if (wallets.devFundedBuyers > g.maxDevFundedBuyers)
          return this.reject(s, `${wallets.devFundedBuyers} buyers funded by the dev`);
        if (wallets.freshPct > g.maxFreshWalletPct)
          return this.retryLater(s, `fresh wallets ${wallets.freshPct.toFixed(0)}%`);
        if (wallets.clusterHoldPct > g.maxClusterHoldPct)
          return this.retryLater(s, `funding clusters hold ${wallets.clusterHoldPct.toFixed(1)}%`);
      } else if (wallets) {
        log.debug(`[engine] wallet analysis failed for $${s.symbol}: ${wallets.error}`);
      }

      // The awaits above took time and trades kept coming: re-decide on fresh state.
      const now = Date.now();
      const f = computeFeatures(s, now, this.featureContext(now));
      const gate = checkGates(f);
      if (!gate.pass) {
        if (gate.permanent) return this.reject(s, gate.reason);
        this.countVerify(`moved during verify: ${gate.reason}`);
        s.status = 'watching';
        s.waitReason = gate.reason;
        return;
      }
      const score = computeScore(f, s.metadata ?? null);
      if (score.total < config.scoring.minScore) {
        this.countVerify(`score below ${config.scoring.minScore} after socials/verify`);
        s.status = 'watching';
        s.waitReason = `score ${score.total} after verify`;
        return;
      }
      if (!this.sol.value) return this.retryLater(s, 'no SOL price yet');
      if (!this.underHourlyCap(now)) return this.retryLater(s, 'hourly signal cap');

      this.countVerify('signal sent');
      await this.emitSignal(s, f, score, oc.ok ? oc : null, rc, now, {
        wallets: wallets?.ok ? wallets : null,
        dexOrders: orders?.ok ? orders : null,
        x: x.ok ? x : null,
      });
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
    extra: Pick<SignalRecord, 'wallets' | 'dexOrders' | 'x'>,
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
      ...extra,
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

  /** "on-chain top10 41.3%" → "on-chain top10 #%" so reasons aggregate. */
  private static category(reason: string): string {
    return reason.replace(/-?\d+(\.\d+)?/g, '#').slice(0, 80);
  }

  private bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private countVerify(reason: string): void {
    this.bump(this.funnel.verifyOutcomes, SignalEngine.category(reason));
  }

  private reject(s: TokenState, reason: string): void {
    this.bump(this.funnel.permanentRejects, SignalEngine.category(reason));
    if (s.status === 'verifying') this.countVerify(`rejected: ${reason}`);
    s.status = 'rejected';
    s.rejectReason = reason;
    this.stats.rejected++;
    log.debug(`[engine] ✗ $${s.symbol} ${reason}`);
  }

  private retryLater(s: TokenState, reason: string): void {
    this.countVerify(`held: ${reason}`);
    s.status = 'watching';
    s.verifyNote = reason;
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

  private foldIntoFunnel(s: TokenState, into = this.funnel): void {
    if (s.bestFailCount === Infinity) return; // never reached min age
    into.matured++;
    if (s.bestFailCount === 0) {
      into.passedGates++;
      if (!s.reachedVerify) into.scoreBlocked++;
    } else if (s.bestFailCount === 1) {
      this.bump(into.nearMiss, s.bestFailKeys[0]);
    }
  }

  /** Funnel since boot, including tokens still being tracked. */
  funnelReport() {
    const f = this.funnel;
    const live = { matured: 0, passedGates: 0, scoreBlocked: 0, nearMiss: new Map(f.nearMiss), verifyOutcomes: f.verifyOutcomes, permanentRejects: f.permanentRejects };
    for (const s of this.tracker.tokens.values()) this.foldIntoFunnel(s, live);
    return {
      sinceMin: (Date.now() - this.startedAt) / 60_000,
      launches: this.stats.created,
      matured: f.matured + live.matured,
      passedGates: f.passedGates + live.passedGates,
      scoreBlocked: f.scoreBlocked + live.scoreBlocked,
      verified: this.stats.verified,
      signals: this.stats.signals,
      nearMiss: [...live.nearMiss.entries()].sort((a, b) => b[1] - a[1]),
      verifyOutcomes: [...f.verifyOutcomes.entries()].sort((a, b) => b[1] - a[1]),
      permanentRejects: [...f.permanentRejects.entries()].sort((a, b) => b[1] - a[1]),
    };
  }

  private drop(s: TokenState, reason: string): void {
    this.foldIntoFunnel(s);
    this.creators.recordPeak(s.mint, s.peakMcapSol);
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
