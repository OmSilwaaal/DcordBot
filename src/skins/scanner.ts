import { EmbedBuilder, type SendableChannels } from 'discord.js';
import { config } from '../config.js';
import { appendJsonl, dailyFile, dataPath, readJson, writeJsonAtomic } from '../utils/files.js';
import { log } from '../utils/logger.js';
import { csfloatQuote } from './csfloat.js';
import { breakEvenSpread, netEdge, VENUES, type VenueName } from './fees.js';
import { BUYABLE, CHINA, MARKET_LABEL, median, PriceBook, WESTERN, type MarketId } from './markets.js';
import { fetchItems, fetchSales, itemKey, type SkinportItem, type SkinportSales } from './skinport.js';

export interface Deal {
  name: string;
  /** Where to buy it. */
  venue: MarketId;
  ask: number;
  /** Conservative exit price: the lower of Skinport's 7d median sale and the median of other Western asks. */
  ref: number;
  sales7d: number;
  sales30dMedian: number | null;
  listings: number;
  edge: number;
  /** Cheapest ask on every market that has one (USD). */
  quotes: Partial<Record<MarketId, number>>;
  /** Median Buff163/Youpin ask — China fair-value benchmark (not tradable for most users). */
  china: number | null;
  /** CSFloat live lowest ask (needs API key) and net edge if sold there. */
  csfloatLow: number | null;
  csfloatEdge: number | null;
  flags: string[];
  url: string;
  at: number;
}

interface Pending {
  name: string;
  venue?: MarketId;
  ask: number;
  ref: number;
  edge: number;
  alertedAt: number;
}

const PENDING_FILE = dataPath('skins-pending.json');
const ALERT_PREFIX = 'skins-alerts';
const OUTCOME_PREFIX = 'skins-outcomes';
const COOLDOWN_MS = 6 * 3600_000;

const buyLink = (venue: MarketId, name: string, skinportUrl: string): string => {
  const q = encodeURIComponent(name);
  if (venue === 'waxpeer') return `https://waxpeer.com/?game=csgo&search=${q}`;
  if (venue === 'marketcsgo') return `https://market.csgo.com/en/?search=${q}`;
  return skinportUrl;
};

export class SkinScanner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastAlert = new Map<string, number>();
  private pending: Pending[] = readJson<Pending[]>(PENDING_FILE, []);
  readonly book = new PriceBook();
  lastDeals: Deal[] = [];
  lastScanAt = 0;
  lastError = '';
  scanned = 0;

  constructor(private readonly getChannel: () => SendableChannels | null) {}

  start(): void {
    const s = config.skins;
    log.info(
      `[skins] scanning Skinport + Waxpeer + Market.CSGO every ${s.intervalMin}m, benchmarks CSFloat/Buff163/Youpin · ` +
        `min net edge ${(s.minNetEdge * 100).toFixed(1)}% · break-even on Skinport ${(breakEvenSpread('skinport') * 100).toFixed(1)}% · ` +
        `CSFloat live check ${s.csfloatKey ? 'on' : 'off'} · read-only alerts`,
    );
    this.timer = setInterval(() => void this.scan(), s.intervalMin * 60_000);
    setTimeout(() => void this.scan(), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const items = await fetchItems();
      if (!items) {
        this.lastError = 'items fetch failed';
        log.warn('[skins] items fetch failed (rate limited or API down)');
        return;
      }
      const sales = await fetchSales();
      if (!sales) {
        this.lastError = 'sales history fetch failed';
        log.warn('[skins] sales history fetch failed');
        return;
      }
      await this.book.refresh(); // other markets failing never blocks the Skinport scan
      this.lastError = '';
      this.lastScanAt = Date.now();
      this.scanned = items.length;
      this.resolveOutcomes(items, sales);

      const deals = this.findDeals(items, sales);
      await this.crossCheck(deals, items);
      this.lastDeals = deals.slice(0, 25);
      const ch = this.getChannel();
      for (const d of deals) {
        const key = `${d.name}@${d.venue}`;
        if (Date.now() - (this.lastAlert.get(key) ?? 0) < COOLDOWN_MS) continue;
        this.lastAlert.set(key, Date.now());
        this.record(d);
        if (ch) await ch.send({ embeds: [dealEmbed(d)] }).catch((e) => log.warn(`[skins] send failed for ${d.name}`, e));
      }
      if (deals.length) log.info(`[skins] ${deals.length} deal(s) over threshold from ${items.length} items`);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      log.error('[skins] scan failed', e);
    } finally {
      this.running = false;
    }
  }

  private findDeals(items: SkinportItem[], sales: Map<string, SkinportSales>): Deal[] {
    const s = config.skins;
    const out: Deal[] = [];
    for (const it of items) {
      if (s.knivesOnly && !it.market_hash_name.startsWith('★')) continue;
      const name = it.market_hash_name;
      const key = itemKey(it);
      const h = sales.get(key);
      const salesMedian = h?.last_7_days.median;
      // Exit is a Skinport sale, so Skinport liquidity gates every venue. Too few sales = no real price.
      if (!h || !salesMedian || h.last_7_days.volume < s.minSales7d) continue;

      // Other markets key by plain name, so phase variants (Doppler etc.) are Skinport-only.
      const multi = !it.version;
      const quotes: Partial<Record<MarketId, number>> = {};
      if (it.min_price) quotes.skinport = it.min_price;
      if (multi) {
        for (const m of ['waxpeer', 'marketcsgo', 'csfloat', 'buff163', 'youpin'] as const) {
          const p = this.book.price(m, name);
          if (p) quotes[m] = p;
        }
      }
      const china = median(CHINA.map((m) => quotes[m]).filter((x): x is number => x !== undefined));

      let best: Deal | null = null;
      for (const venue of multi ? BUYABLE : (['skinport'] as MarketId[])) {
        const ask = quotes[venue];
        if (!ask || ask < s.minPrice || ask > s.maxPrice) continue;

        // Exit price: Skinport's actual 7d median sale, capped by what other Western markets ask.
        // Asks are not sales, so they can only lower the reference, never raise it.
        const others = WESTERN.filter((m) => m !== venue)
          .map((m) => quotes[m])
          .filter((x): x is number => x !== undefined);
        const othersMedian = others.length >= 2 ? median(others) : null;
        const ref = othersMedian ? Math.min(salesMedian, othersMedian) : salesMedian;

        const edge = netEdge(ask, ref, venue as VenueName, 'skinport');
        if (edge < s.minNetEdge || edge > s.maxNetEdge) continue; // >max is almost always a mismatched comparison

        const flags = ['7-day trade lock after purchase'];
        if (venue !== 'skinport') flags.push(`buying on ${MARKET_LABEL[venue]}: check its payment/withdrawal rules and seller reputation`);
        if (it.quantity <= 1) flags.push('only 1 Skinport listing — may be a stale float/pattern premium');
        if (h.last_7_days.volume < 5) flags.push(`thin market (${h.last_7_days.volume} sales/7d)`);
        const m30 = h.last_30_days.median;
        if (m30 && salesMedian < m30 * 0.9) flags.push('7d median is >10% below 30d median — price is falling');
        if (edge > 0.25) flags.push('edge >25% — check float/pattern/stickers, may not be like-for-like');
        if (!name.includes('|')) flags.push('base item (no skin) — pattern/float not comparable');
        if (!multi) flags.push('phase/version variant — only Skinport priced');
        else if (othersMedian && othersMedian < salesMedian * 0.9) flags.push('other markets ask >10% less than Skinport sales — reference lowered');
        if (china) {
          // Chinese markets run a few % below the West, so use a buffer before calling anything a discrepancy.
          if (ask <= china) flags.push(`ask is at/below the China benchmark ($${china.toFixed(2)}) — strong sign it is cheap`);
          else if (ref > china * (1 + config.skins.chinaBuffer)) flags.push(`exit price is ${(((ref / china) - 1) * 100).toFixed(0)}% above Buff163/Youpin — Western price may be inflated`);
        }
        if (best === null || edge > best.edge) {
          best = {
            name: key,
            venue,
            ask,
            ref,
            sales7d: h.last_7_days.volume,
            sales30dMedian: m30,
            listings: it.quantity,
            edge,
            quotes,
            china,
            csfloatLow: null,
            csfloatEdge: null,
            flags,
            url: buyLink(venue, name, it.market_page || it.item_page),
            at: Date.now(),
          };
        }
      }
      if (best) out.push(best);
    }
    return out.sort((a, b) => b.edge - a.edge).slice(0, s.maxAlertsPerScan);
  }

  /** Live CSFloat check (needs key) for the few alert candidates; daily snapshot values stay in `quotes`. */
  private async crossCheck(deals: Deal[], items: SkinportItem[]): Promise<void> {
    if (!config.skins.csfloatKey) return;
    const versioned = new Set(items.filter((i) => i.version).map((i) => itemKey(i)));
    for (const d of deals) {
      if (versioned.has(d.name)) {
        d.flags.push('CSFloat not checked (phase/version variant)');
        continue;
      }
      const q = await csfloatQuote(d.name);
      if (!q) {
        d.flags.push('CSFloat live check unavailable');
        continue;
      }
      d.csfloatLow = q.lowest;
      d.csfloatEdge = netEdge(d.ask, q.lowest, d.venue as VenueName, 'csfloat');
      if (q.lowest <= d.ask) d.flags.push('CSFloat has an equal or cheaper live ask — not an outlier');
      else if (d.csfloatEdge < config.skins.minNetEdge) d.flags.push('would not clear the edge threshold if sold on CSFloat');
    }
  }

  /** Alerts are logged on day one so outcomes can be backtested later. */
  private record(d: Deal): void {
    appendJsonl(dailyFile(ALERT_PREFIX), d);
    this.pending.push({ name: d.name, venue: d.venue, ask: d.ask, ref: d.ref, edge: d.edge, alertedAt: d.at });
    writeJsonAtomic(PENDING_FILE, this.pending);
  }

  /** N days after an alert, log where the item's price actually went. */
  private resolveOutcomes(items: SkinportItem[], sales: Map<string, SkinportSales>): void {
    const due = Date.now() - config.skins.outcomeDays * 86_400_000;
    const keep: Pending[] = [];
    const byName = new Map(items.map((i) => [itemKey(i), i]));
    let resolved = 0;
    for (const p of this.pending) {
      if (p.alertedAt > due) {
        keep.push(p);
        continue;
      }
      const now = byName.get(p.name);
      const med = sales.get(p.name)?.last_7_days.median ?? null;
      appendJsonl(dailyFile(OUTCOME_PREFIX), {
        ...p,
        resolvedAt: Date.now(),
        minPriceNow: now?.min_price ?? null,
        median7dNow: med,
        // What selling at the later Skinport median would have netted vs the original ask.
        realizedEdge: med ? netEdge(p.ask, med, (p.venue ?? 'skinport') as VenueName, 'skinport') : null,
      });
      resolved++;
    }
    if (resolved) {
      this.pending = keep;
      writeJsonAtomic(PENDING_FILE, this.pending);
      log.info(`[skins] logged ${resolved} alert outcome(s)`);
    }
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const ORDER: MarketId[] = ['skinport', 'waxpeer', 'marketcsgo', 'csfloat', 'buff163', 'youpin'];

export function dealEmbed(d: Deal): EmbedBuilder {
  const sellFee = VENUES.skinport.sellFee;
  const table = ORDER.filter((m) => d.quotes[m] !== undefined)
    .map((m) => `${m === d.venue ? '**' : ''}${MARKET_LABEL[m]}: ${usd(d.quotes[m]!)}${m === d.venue ? ' ← buy**' : ''}`)
    .join('\n');
  return new EmbedBuilder()
    .setColor(d.edge >= 0.15 ? 0x2ecc71 : 0xf1c40f)
    .setTitle(d.name.slice(0, 250))
    .setURL(d.url)
    .setDescription(
      `Buy on **${MARKET_LABEL[d.venue]}** · net edge **${(d.edge * 100).toFixed(1)}%** selling on Skinport (${(sellFee * 100).toFixed(1)}% fee)`,
    )
    .addFields(
      { name: 'Ask', value: usd(d.ask), inline: true },
      { name: 'Exit ref', value: usd(d.ref), inline: true },
      { name: 'Sales 7d', value: String(d.sales7d), inline: true },
      { name: 'Skinport listings', value: String(d.listings), inline: true },
      { name: '30d median', value: d.sales30dMedian ? usd(d.sales30dMedian) : 'n/a', inline: true },
      {
        name: 'CSFloat live ask',
        value: d.csfloatLow ? `${usd(d.csfloatLow)} (net ${(d.csfloatEdge! * 100).toFixed(1)}% if sold there)` : 'n/a',
        inline: true,
      },
      { name: 'Markets (cheapest ask)', value: table.slice(0, 1000) || 'n/a' },
      { name: 'Risk flags', value: d.flags.map((f) => `• ${f}`).join('\n').slice(0, 1000) },
    )
    .setFooter({ text: 'Read-only alert — not financial advice. Float/pattern not checked. CSFloat/Buff/Youpin are daily snapshots.' })
    .setTimestamp(d.at);
}
