import { fetchJson } from '../utils/http.js';
import { log } from '../utils/logger.js';

/**
 * Price sources beyond Skinport. All free and key-less, verified Oct 2026:
 *  - waxpeer, marketcsgo: live listings from markets a Western user can buy on.
 *  - csfloat, buff163, youpin: csgotrader.app's daily snapshots. Reference only — they are
 *    up to a day old, and Buff/Youpin (China) cannot be traded by non-Chinese users.
 */
export type MarketId = 'skinport' | 'waxpeer' | 'marketcsgo' | 'csfloat' | 'buff163' | 'youpin';

export const MARKET_LABEL: Record<MarketId, string> = {
  skinport: 'Skinport',
  waxpeer: 'Waxpeer',
  marketcsgo: 'Market.CSGO',
  csfloat: 'CSFloat',
  buff163: 'Buff163',
  youpin: 'Youpin',
};

/** Markets a Western buyer can realistically buy from today. */
export const BUYABLE: MarketId[] = ['skinport', 'waxpeer', 'marketcsgo'];
/** Western markets used to cross-check a price. */
export const WESTERN: MarketId[] = ['skinport', 'waxpeer', 'marketcsgo', 'csfloat'];
/** Chinese markets: fair-value benchmark only. */
export const CHINA: MarketId[] = ['buff163', 'youpin'];

type Prices = Map<string, number>;

interface Source {
  id: Exclude<MarketId, 'skinport'>;
  ttlMs: number;
  load: () => Promise<Prices | null>;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** csgotrader.app/latest/<provider>.json: { name: { starting_at: { price }, ... } | { price } } */
function trader(id: 'buff163' | 'youpin898' | 'csfloat'): () => Promise<Prices | null> {
  return async () => {
    type Row = { price?: number | null; starting_at?: { price?: number | null } | number | null };
    const r = await fetchJson<Record<string, Row>>(`https://prices.csgotrader.app/latest/${id}.json`, { timeoutMs: 60_000 });
    if (!r.ok || !r.data) return null;
    const out: Prices = new Map();
    for (const [name, row] of Object.entries(r.data)) {
      const sa = row.starting_at;
      const p = num(typeof sa === 'object' && sa !== null ? sa.price : sa) ?? num(row.price);
      if (p) out.set(name, p);
    }
    return out;
  };
}

const SOURCES: Source[] = [
  {
    id: 'waxpeer',
    ttlMs: 10 * MIN,
    load: async () => {
      // `min` is in thousandths of a USD (calibrated against Skinport: median ratio 1.02).
      const r = await fetchJson<{ items?: { name: string; min: number }[] }>(
        'https://api.waxpeer.com/v1/prices?game=csgo&min_price=0&max_price=100000000',
        { timeoutMs: 60_000 },
      );
      if (!r.ok || !r.data?.items) return null;
      const out: Prices = new Map();
      for (const i of r.data.items) {
        const p = num(i.min);
        if (p) out.set(i.name, p / 1000);
      }
      return out;
    },
  },
  {
    id: 'marketcsgo',
    ttlMs: 10 * MIN,
    load: async () => {
      const r = await fetchJson<{ items?: { market_hash_name: string; price: string }[] }>(
        'https://market.csgo.com/api/v2/prices/USD.json',
        { timeoutMs: 60_000 },
      );
      if (!r.ok || !r.data?.items) return null;
      const out: Prices = new Map();
      for (const i of r.data.items) {
        const p = num(Number(i.price));
        if (p) out.set(i.market_hash_name, p);
      }
      return out;
    },
  },
  { id: 'csfloat', ttlMs: 3 * HOUR, load: trader('csfloat') },
  { id: 'buff163', ttlMs: 3 * HOUR, load: trader('buff163') },
  { id: 'youpin', ttlMs: 3 * HOUR, load: trader('youpin898') },
];

/** Older than this and a snapshot is ignored rather than trusted. */
const MAX_AGE_MS = 36 * HOUR;

export class PriceBook {
  private data = new Map<MarketId, { at: number; prices: Prices }>();
  /** Last error per market, for /skinstatus. */
  readonly errors = new Map<MarketId, string>();

  /** Reloads any source past its TTL. A failed reload keeps the old data until it ages out. */
  async refresh(): Promise<void> {
    await Promise.all(
      SOURCES.map(async (s) => {
        const have = this.data.get(s.id);
        if (have && Date.now() - have.at < s.ttlMs) return;
        try {
          const prices = await s.load();
          if (prices && prices.size > 0) {
            this.data.set(s.id, { at: Date.now(), prices });
            this.errors.delete(s.id);
            log.info(`[skins] ${s.id}: ${prices.size} prices`);
          } else {
            this.errors.set(s.id, 'fetch failed');
            log.warn(`[skins] ${s.id}: fetch failed${have ? ' (using older data)' : ''}`);
          }
        } catch (e) {
          this.errors.set(s.id, e instanceof Error ? e.message : String(e));
          log.warn(`[skins] ${s.id}: error`, e);
        }
      }),
    );
  }

  /** Price on `market`, or null when unknown or the snapshot is too old to trust. */
  price(market: Exclude<MarketId, 'skinport'>, name: string): number | null {
    const d = this.data.get(market);
    if (!d || Date.now() - d.at > MAX_AGE_MS) return null;
    return d.prices.get(name) ?? null;
  }

  /** Per-market status for diagnostics. */
  status(): { id: MarketId; items: number; ageMin: number | null; error?: string }[] {
    return SOURCES.map((s) => {
      const d = this.data.get(s.id);
      return { id: s.id, items: d?.prices.size ?? 0, ageMin: d ? Math.round((Date.now() - d.at) / MIN) : null, error: this.errors.get(s.id) };
    });
  }
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
