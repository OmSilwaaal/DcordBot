import { config } from '../config.js';
import type { RugcheckResult } from '../types.js';
import { fetchJson } from '../utils/http.js';
import { RateLimiter } from '../utils/limiter.js';

const limiter = new RateLimiter(0.5, 2); // ~1 call / 2s, shared
const cache = new Map<string, { at: number; res: RugcheckResult }>();

interface Summary {
  score?: number;
  score_normalised?: number;
  risks?: { name?: string; level?: string }[];
}

/**
 * RugCheck as a second opinion. Unlike the original, an error is reported as
 * "unavailable" — never as "safe". Only called for candidates, and cached.
 */
export async function rugcheck(mint: string): Promise<RugcheckResult> {
  const hit = cache.get(mint);
  const ttl = hit?.res.status === 'unavailable' ? 30_000 : 120_000;
  if (hit && Date.now() - hit.at < ttl) return hit.res;

  const r = await fetchJson<Summary>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, {
    limiter,
    retries: 1,
    timeoutMs: 8000,
  });

  let res: RugcheckResult;
  if (r.status === 404) {
    res = { status: 'not_found', dangers: [], warnings: [] };
  } else if (!r.ok || !r.data) {
    res = { status: 'unavailable', dangers: [], warnings: [] };
  } else {
    const ignore = (name: string) => config.gates.rugcheckIgnore.some((s) => name.toLowerCase().includes(s));
    const risks = (r.data.risks ?? []).filter((x) => x?.name && !ignore(x.name));
    res = {
      status: 'ok',
      score: r.data.score,
      scoreNormalised: r.data.score_normalised,
      dangers: risks.filter((x) => x.level === 'danger').map((x) => x.name!),
      warnings: risks.filter((x) => x.level === 'warn').map((x) => x.name!),
    };
  }
  cache.set(mint, { at: Date.now(), res });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return res;
}
