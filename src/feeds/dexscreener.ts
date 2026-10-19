import { fetchJson } from '../utils/http.js';
import { RateLimiter } from '../utils/limiter.js';
import { chunks } from '../utils/math.js';

export interface DexPair {
  chainId: string;
  dexId: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
}

export const WSOL = 'So11111111111111111111111111111111111111112';

// /tokens/v1 allows 300 req/min; we stay far below it.
const limiter = new RateLimiter(2, 4);

export async function getPairs(mints: string[]): Promise<DexPair[]> {
  const out: DexPair[] = [];
  for (const c of chunks(mints, 30)) {
    const r = await fetchJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${c.join(',')}`, {
      limiter,
      retries: 1,
    });
    if (r.ok && Array.isArray(r.data)) out.push(...r.data);
  }
  return out;
}

/** USD market cap per mint, from that mint's most liquid pair. Used for outcome tracking after graduation. */
export async function getMarketCaps(mints: string[]): Promise<Map<string, number>> {
  const wanted = new Set(mints);
  const best = new Map<string, DexPair>();
  for (const p of await getPairs(mints)) {
    const a = p.baseToken?.address;
    if (!a || !wanted.has(a)) continue;
    const cur = best.get(a);
    if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(a, p);
  }
  const out = new Map<string, number>();
  for (const [a, p] of best) {
    const mc = p.marketCap ?? p.fdv;
    if (mc && mc > 0) out.set(a, mc);
  }
  return out;
}
