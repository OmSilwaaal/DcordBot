import { dataPath, readJson, writeJsonAtomic } from '../utils/files.js';

interface CreatorRecord {
  launches: number;
  graduated: number;
  bestPeakSol: number;
  /** Most recent launch times (ms), newest last, capped. */
  recent: number[];
}

export interface CreatorStats {
  priorLaunches: number;
  launches24h: number;
  priorGraduated: number;
  bestPriorPeakSol: number;
  minSinceLast: number;
}

const KEEP_DAYS = 30;
const MINT_MAP_HOURS = 48;
const MAX_RECENT = 20;

/**
 * Every creator wallet the bot has seen launch a token, with how those launches went.
 * Persisted to data/creators.json, so it gets more useful the longer the bot runs.
 */
export class CreatorBook {
  private creators = new Map<string, CreatorRecord>();
  /** mint → [creator, launchedAt], so graduations and peaks can be credited back. */
  private mints = new Map<string, [string, number]>();
  private dirty = false;
  private readonly file = dataPath('creators.json');

  constructor() {
    const saved = readJson<{ creators?: [string, CreatorRecord][]; mints?: [string, [string, number]][] }>(this.file, {});
    for (const [k, v] of saved.creators ?? []) this.creators.set(k, v);
    for (const [k, v] of saved.mints ?? []) this.mints.set(k, v);
    this.prune(Date.now());
  }

  get size(): number {
    return this.creators.size;
  }

  recordLaunch(creator: string, mint: string, ts: number): void {
    if (!creator) return;
    const r = this.creators.get(creator) ?? { launches: 0, graduated: 0, bestPeakSol: 0, recent: [] };
    r.launches++;
    r.recent.push(ts);
    if (r.recent.length > MAX_RECENT) r.recent.splice(0, r.recent.length - MAX_RECENT);
    this.creators.set(creator, r);
    this.mints.set(mint, [creator, ts]);
    this.dirty = true;
  }

  recordGraduation(mint: string): void {
    const m = this.mints.get(mint);
    const r = m && this.creators.get(m[0]);
    if (!r) return;
    r.graduated++;
    this.dirty = true;
  }

  recordPeak(mint: string, peakMcapSol: number): void {
    const m = this.mints.get(mint);
    const r = m && this.creators.get(m[0]);
    if (!r || !(peakMcapSol > r.bestPeakSol)) return;
    r.bestPeakSol = peakMcapSol;
    this.dirty = true;
  }

  /** Stats for a creator *before* the given launch (that launch itself excluded). */
  stats(creator: string, launchTs: number): CreatorStats {
    const r = this.creators.get(creator);
    if (!r) return { priorLaunches: 0, launches24h: 0, priorGraduated: 0, bestPriorPeakSol: 0, minSinceLast: -1 };
    const prior = r.recent.filter((t) => t < launchTs);
    const last = prior.length ? prior[prior.length - 1] : null;
    return {
      priorLaunches: Math.max(0, r.launches - (r.recent.includes(launchTs) ? 1 : 0)),
      launches24h: prior.filter((t) => launchTs - t < 86_400_000).length,
      priorGraduated: r.graduated,
      bestPriorPeakSol: r.bestPeakSol,
      minSinceLast: last === null ? -1 : (launchTs - last) / 60_000,
    };
  }

  save(): void {
    if (!this.dirty) return;
    this.prune(Date.now());
    writeJsonAtomic(this.file, { creators: [...this.creators], mints: [...this.mints] });
    this.dirty = false;
  }

  private prune(now: number): void {
    for (const [k, r] of this.creators) {
      const last = r.recent[r.recent.length - 1] ?? 0;
      if (now - last > KEEP_DAYS * 86_400_000) this.creators.delete(k);
    }
    for (const [k, [, ts]] of this.mints) if (now - ts > MINT_MAP_HOURS * 3_600_000) this.mints.delete(k);
  }
}
