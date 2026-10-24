import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import type { PerfState, SignalRecord, SimState } from '../types.js';
import { appendJsonl, dataPath, readJson, readJsonl, writeJsonAtomic } from '../utils/files.js';
import { median } from '../utils/math.js';
import { pushPath } from '../utils/path.js';

export const CHECKPOINTS = [
  { key: '5m', min: 5 },
  { key: '15m', min: 15 },
  { key: '30m', min: 30 },
  { key: '60m', min: 60 },
];

export function newPerfState(): PerfState {
  return {
    samples: 0,
    lastMult: 1,
    peakMult: 1,
    peakAtMin: 0,
    troughMult: 1,
    checkpoints: Object.fromEntries(CHECKPOINTS.map((c) => [c.key, null])),
    graduated: false,
    lastUpdate: 0,
    path: [],
    sim: openSim(),
    shadow: Object.fromEntries(config.plan.shadow.map((s) => [s.name, { ...openSim(), highMult: 1 }])),
  };
}

const openSim = (): SimState => ({ open: true, exitReason: null, exitMult: null, returnPct: null });

export interface Summary {
  n: number;
  active: number;
  tpRate: number;
  slRate: number;
  timeRate: number;
  avgReturnPct: number;
  medianReturnPct: number;
  medianPeak: number;
  pct2x: number;
  pct3x: number;
  byTier: Record<string, { n: number; avgReturnPct: number; tpRate: number }>;
  /** Per shadow plan, over finished signals that carry it. */
  shadow: Record<string, { n: number; avgReturnPct: number; medianReturnPct: number; tpRate: number; slRate: number }>;
}

/**
 * Forward-tests every signal against the configured plan (entry slippage,
 * stop, target, time stop, costs). This is how you find out whether the
 * signals have edge — and it answers "what stop loss?" with data.
 *
 * Fills: TP is assumed at the target; SL fills at the observed price, which
 * is usually *below* the stop because meme coins gap. That's deliberately
 * conservative.
 */
export class PerformanceTracker extends EventEmitter {
  readonly active = new Map<string, SignalRecord>();
  private dirty = false;
  private readonly activeFile = dataPath('signals-active.json');
  private readonly doneFile = dataPath('signals.jsonl');

  constructor(private readonly plan = config.plan) {
    super();
    for (const r of readJson<SignalRecord[]>(this.activeFile, [])) this.active.set(r.mint, r);
  }

  mints(): string[] {
    return [...this.active.keys()];
  }

  add(r: SignalRecord): void {
    this.active.set(r.mint, r);
    this.dirty = true;
    this.save();
  }

  markDirty(): void {
    this.dirty = true;
  }

  onPrice(mint: string, mcapUsd: number, ts: number): void {
    const r = this.active.get(mint);
    if (!r || r.finalizedAt || !(mcapUsd > 0)) return;
    const p = r.perf;
    const elapsedMin = (ts - r.signaledAt) / 60_000;
    if (elapsedMin < 0) return;

    const mult = mcapUsd / r.entryMcapUsd;
    // Shadow time stops exit at the last price seen before their deadline, not this one.
    this.closeExpiredShadows(r, elapsedMin);
    p.samples++;
    p.lastMult = mult;
    p.lastUpdate = ts;
    if (mult > p.peakMult) {
      p.peakMult = mult;
      p.peakAtMin = elapsedMin;
    }
    if (mult < p.troughMult) p.troughMult = mult;
    pushPath((p.path ??= []), elapsedMin * 60, mult);
    for (const c of CHECKPOINTS) if (p.checkpoints[c.key] === null && elapsedMin >= c.min) p.checkpoints[c.key] = mult;

    if (p.sim.open) {
      const simMult = mult / (1 + this.plan.entrySlippagePct / 100);
      if (simMult <= 1 - this.plan.stopLossPct / 100) this.close(r, 'sl', simMult);
      else if (simMult >= this.plan.takeProfitMult) this.close(r, 'tp', this.plan.takeProfitMult);
    }
    this.stepShadows(r, mult);
    this.dirty = true;
  }

  markGraduated(mint: string): void {
    const r = this.active.get(mint);
    if (r) {
      r.perf.graduated = true;
      this.dirty = true;
    }
  }

  /** Finalize signals whose tracking window (= plan time stop) has elapsed. */
  tick(now: number): void {
    for (const r of [...this.active.values()]) {
      if (now - r.signaledAt >= this.plan.timeStopMin * 60_000) this.finalize(r, now);
      else if (this.closeExpiredShadows(r, (now - r.signaledAt) / 60_000)) this.dirty = true;
    }
  }

  save(): void {
    if (!this.dirty) return;
    writeJsonAtomic(this.activeFile, [...this.active.values()]);
    this.dirty = false;
  }

  finished(): SignalRecord[] {
    return readJsonl<SignalRecord>(this.doneFile);
  }

  summary(hours: number): Summary {
    const since = Date.now() - hours * 3_600_000;
    const done = this.finished().filter((r) => r.signaledAt >= since);
    const rets = done.map((r) => r.perf.sim.returnPct ?? 0);
    const rate = (pred: (r: SignalRecord) => boolean) => (done.length ? (done.filter(pred).length / done.length) * 100 : 0);
    const byTier: Summary['byTier'] = {};
    for (const t of ['A', 'B', 'C']) {
      const rs = done.filter((r) => r.tier === t);
      if (!rs.length) continue;
      byTier[t] = {
        n: rs.length,
        avgReturnPct: rs.reduce((a, r) => a + (r.perf.sim.returnPct ?? 0), 0) / rs.length,
        tpRate: (rs.filter((r) => r.perf.sim.exitReason === 'tp').length / rs.length) * 100,
      };
    }
    return {
      n: done.length,
      active: this.active.size,
      tpRate: rate((r) => r.perf.sim.exitReason === 'tp'),
      slRate: rate((r) => r.perf.sim.exitReason === 'sl'),
      timeRate: rate((r) => r.perf.sim.exitReason === 'time'),
      avgReturnPct: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0,
      medianReturnPct: median(rets),
      medianPeak: median(done.map((r) => r.perf.peakMult)),
      pct2x: rate((r) => r.perf.peakMult >= 2),
      pct3x: rate((r) => r.perf.peakMult >= 3),
      byTier,
      shadow: Object.fromEntries(
        this.plan.shadow.flatMap((pl) => {
          const ss: SimState[] = [];
          for (const r of done) {
            const x = r.perf.shadow?.[pl.name];
            if (x && x.returnPct !== null) ss.push(x);
          }
          if (!ss.length) return [];
          const rs = ss.map((x) => x.returnPct ?? 0);
          const share = (reason: SimState['exitReason']) => (ss.filter((x) => x.exitReason === reason).length / ss.length) * 100;
          const stats = { n: ss.length, avgReturnPct: rs.reduce((a, b) => a + b, 0) / rs.length, medianReturnPct: median(rs), tpRate: share('tp'), slRate: share('sl') };
          return [[pl.name, stats]];
        }),
      ),
    };
  }

  private stepShadows(r: SignalRecord, mult: number): void {
    const simMult = mult / (1 + this.plan.entrySlippagePct / 100);
    for (const pl of this.plan.shadow) {
      const s = r.perf.shadow?.[pl.name];
      if (!s?.open) continue;
      let stop = 1 - pl.stopLossPct / 100;
      if (pl.trailPct !== null) stop = Math.max(stop, s.highMult * (1 - pl.trailPct / 100));
      if (simMult <= stop) this.closeSim(s, 'sl', simMult);
      else if (pl.takeProfitMult !== null && simMult >= pl.takeProfitMult) this.closeSim(s, 'tp', pl.takeProfitMult);
      else if (simMult > s.highMult) s.highMult = simMult;
    }
  }

  /** Closes shadow plans whose time stop has passed at the last observed price. Returns whether any closed. */
  private closeExpiredShadows(r: SignalRecord, elapsedMin: number): boolean {
    let closed = false;
    for (const pl of this.plan.shadow) {
      const s = r.perf.shadow?.[pl.name];
      if (!s?.open || elapsedMin < pl.timeStopMin) continue;
      this.closeSim(s, 'time', r.perf.lastMult / (1 + this.plan.entrySlippagePct / 100));
      closed = true;
    }
    return closed;
  }

  private close(r: SignalRecord, reason: 'tp' | 'sl' | 'time', exitMult: number): void {
    this.closeSim(r.perf.sim, reason, exitMult);
  }

  private closeSim(s: SimState, reason: 'tp' | 'sl' | 'time', exitMult: number): void {
    s.open = false;
    s.exitReason = reason;
    s.exitMult = exitMult;
    s.returnPct = (exitMult * (1 - this.plan.roundTripCostPct / 100) - 1) * 100;
  }

  private finalize(r: SignalRecord, now: number): void {
    const p = r.perf;
    for (const c of CHECKPOINTS) if (p.checkpoints[c.key] === null) p.checkpoints[c.key] = p.lastMult;
    if (p.sim.open) this.close(r, 'time', p.lastMult / (1 + this.plan.entrySlippagePct / 100));
    this.closeExpiredShadows(r, Infinity);
    r.finalizedAt = now;
    appendJsonl(this.doneFile, r);
    this.active.delete(r.mint);
    this.dirty = true;
    this.save();
    this.emit('finalized', r);
  }
}
