import { RateLimiter } from '../utils/limiter.js';
import { fetchJson } from '../utils/http.js';

const BASE = 'https://api.skinport.com/v1';
// 8 requests per 5 minutes per endpoint; stay well under it.
const limiter = new RateLimiter(8 / 300, 1);
// Node's fetch negotiates and decodes brotli itself; the API refuses requests without it.
const headers = { 'Accept-Encoding': 'br' };

export interface SkinportItem {
  market_hash_name: string;
  /** Doppler phase etc. — same name, very different prices. */
  version: string | null;
  currency: string;
  suggested_price: number | null;
  item_page: string;
  market_page: string;
  min_price: number | null;
  max_price: number | null;
  mean_price: number | null;
  median_price: number | null;
  quantity: number;
}

export interface SalesWindow {
  min: number | null;
  max: number | null;
  avg: number | null;
  median: number | null;
  volume: number;
}

export interface SkinportSales {
  market_hash_name: string;
  version: string | null;
  last_24_hours: SalesWindow;
  last_7_days: SalesWindow;
  last_30_days: SalesWindow;
  last_90_days: SalesWindow;
}

/** Name alone is ambiguous: Dopplers share a name across phases. */
export const itemKey = (x: { market_hash_name: string; version: string | null }): string =>
  x.version ? `${x.market_hash_name} [${x.version}]` : x.market_hash_name;

const q = 'app_id=730&currency=USD';

export async function fetchItems(): Promise<SkinportItem[] | null> {
  const r = await fetchJson<SkinportItem[]>(`${BASE}/items?${q}&tradable=0`, { limiter, headers, timeoutMs: 30_000 });
  return r.ok && Array.isArray(r.data) ? r.data : null;
}

export async function fetchSales(): Promise<Map<string, SkinportSales> | null> {
  const r = await fetchJson<SkinportSales[]>(`${BASE}/sales/history?${q}`, { limiter, headers, timeoutMs: 30_000 });
  if (!r.ok || !Array.isArray(r.data)) return null;
  return new Map(r.data.map((s) => [itemKey(s), s]));
}
