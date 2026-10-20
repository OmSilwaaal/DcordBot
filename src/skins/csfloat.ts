import { config } from '../config.js';
import { fetchJson } from '../utils/http.js';
import { RateLimiter } from '../utils/limiter.js';

const limiter = new RateLimiter(0.5, 1);
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: CsfloatQuote | null }>();

export interface CsfloatQuote {
  /** Cheapest current buy-now ask in USD. An ask, not a sale price. */
  lowest: number;
  listings: number;
}

interface Listing {
  price: number; // cents
  type?: string;
}

export const csfloatEnabled = (): boolean => config.skins.csfloatKey !== '';

/**
 * Lowest buy-now ask for an exact market_hash_name on CSFloat (key in CSFLOAT_API_KEY).
 * Response shape is untested against live data (needs a key): handles both a bare
 * array and `{ data: [...] }`. Returns null on any failure — never guesses.
 */
export async function csfloatQuote(name: string): Promise<CsfloatQuote | null> {
  if (!csfloatEnabled()) return null;
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const url =
    `https://csfloat.com/api/v1/listings?limit=10&sort_by=lowest_price&type=buy_now` +
    `&market_hash_name=${encodeURIComponent(name)}`;
  const r = await fetchJson<Listing[] | { data: Listing[] }>(url, {
    limiter,
    headers: { Authorization: config.skins.csfloatKey },
    retries: 0,
  });
  if (!r.ok || !r.data) return null; // don't cache failures
  const rows = Array.isArray(r.data) ? r.data : r.data.data;
  const prices = (rows ?? []).filter((l) => l.type !== 'auction' && Number.isFinite(l.price)).map((l) => l.price / 100);
  const value = prices.length ? { lowest: Math.min(...prices), listings: prices.length } : null;
  cache.set(name, { at: Date.now(), value });
  return value;
}
