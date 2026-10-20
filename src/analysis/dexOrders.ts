import type { DexOrders } from '../types.js';
import { fetchJson } from '../utils/http.js';
import { RateLimiter } from '../utils/limiter.js';

const limiter = new RateLimiter(1, 2); // orders endpoint has a tighter limit than pair lookups
const cache = new Map<string, { at: number; res: DexOrders }>();

interface Order {
  type?: string;
  status?: string;
  paymentTimestamp?: number;
}

/**
 * Paid DexScreener promotion (profile, community takeover, ads, boosts).
 * Someone spending money can mean commitment — or a planned pump. Logged, not gated, until the data says which.
 */
export async function dexOrders(mint: string, launchedAt: number): Promise<DexOrders> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < 120_000) return hit.res;

  const r = await fetchJson<Order[] | { orders?: Order[]; boosts?: unknown[] }>(
    `https://api.dexscreener.com/orders/v1/solana/${mint}`,
    { limiter, retries: 1, timeoutMs: 6000 },
  );
  let res: DexOrders;
  if (!r.ok || !r.data) {
    res = { ok: r.status === 404, paidProfile: false, communityTakeover: false, ads: 0, boosts: 0, minToFirstPaid: -1 };
  } else {
    const orders = Array.isArray(r.data) ? r.data : (r.data.orders ?? []);
    const boosts = Array.isArray(r.data) ? [] : (r.data.boosts ?? []);
    const live = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'rejected');
    const paidTimes = live.map((o) => o.paymentTimestamp ?? 0).filter((t) => t > 0);
    const first = paidTimes.length ? Math.min(...paidTimes) : 0;
    res = {
      ok: true,
      paidProfile: live.some((o) => o.type === 'tokenProfile'),
      communityTakeover: live.some((o) => o.type === 'communityTakeover'),
      ads: live.filter((o) => (o.type ?? '').toLowerCase().includes('ad')).length,
      boosts: boosts.length,
      minToFirstPaid: first ? Math.max(0, (first - launchedAt) / 60_000) : -1,
    };
  }
  cache.set(mint, { at: Date.now(), res });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return res;
}
