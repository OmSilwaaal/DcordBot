import { EmbedBuilder, type SendableChannels } from 'discord.js';
import { config } from '../config.js';
import { appendJsonl, dailyFile, dataPath, readJson, writeJsonAtomic } from '../utils/files.js';
import { log } from '../utils/logger.js';
import { csfloatQuote } from './csfloat.js';
import { breakEvenSpread, netEdge, VENUES } from './fees.js';
import { fetchItems, fetchSales, itemKey, type SkinportItem, type SkinportSales } from './skinport.js';

export interface Deal {
  name: string;
  ask: number;
  /** 7-day median of actual sales — the reference price. */
  ref: number;
  sales7d: number;
  sales30dMedian: number | null;
  listings: number;
  edge: number;
  /** CSFloat cheapest ask and the net edge if sold there (null = not checked). */
  csfloatLow: number | null;
  csfloatEdge: number | null;
  flags: string[];
  url: string;
  at: number;
}

interface Pending {
  name: string;
  ask: number;
  ref: number;
  edge: number;
  alertedAt: number;
}

const PENDING_FILE = dataPath('skins-pending.json');
const ALERT_PREFIX = 'skins-alerts';
const OUTCOME_PREFIX = 'skins-outcomes';
const COOLDOWN_MS = 6 * 3600_000;

export class SkinScanner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastAlert = new Map<string, number>();
  private pending: Pending[] = readJson<Pending[]>(PENDING_FILE, []);
  lastDeals: Deal[] = [];
  lastScanAt = 0;
  lastError = '';
  scanned = 0;

  constructor(private readonly getChannel: () => SendableChannels | null) {}

  start(): void {
    const s = config.skins;
    log.info(
      `[skins] scanning Skinport every ${s.intervalMin}m · min net edge ${(s.minNetEdge * 100).toFixed(1)}% · ` +
        `break-even on Skinport ${(breakEvenSpread('skinport') * 100).toFixed(1)}% · read-only alerts`,
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
      this.lastError = '';
      this.lastScanAt = Date.now();
      this.scanned = items.length;
      this.resolveOutcomes(items, sales);

      const deals = this.findDeals(items, sales);
      await this.crossCheck(deals, items);
      this.lastDeals = deals.slice(0, 25);
      const ch = this.getChannel();
      for (const d of deals) {
        const last = this.lastAlert.get(d.name) ?? 0;
        if (Date.now() - last < COOLDOWN_MS) continue;
        this.lastAlert.set(d.name, Date.now());
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
      const ask = it.min_price;
      if (!ask || ask < s.minPrice || ask > s.maxPrice) continue;
      if (s.knivesOnly && !it.market_hash_name.startsWith('★')) continue;
      const key = itemKey(it);
      const h = sales.get(key);
      const ref = h?.last_7_days.median;
      // A reference built from too few sales is one lucky listing, not a price.
      if (!h || !ref || h.last_7_days.volume < s.minSales7d) continue;

      const edge = netEdge(ask, ref, 'skinport', 'skinport');
      if (edge < s.minNetEdge) continue;
      // Past this it's almost always a mismatched comparison (phase/float/pattern), not a deal.
      if (edge > s.maxNetEdge) continue;

      const flags = ['7-day trade lock after purchase'];
      if (it.quantity <= 1) flags.push('only 1 listing — may be a mispriced outlier or a stale float/pattern premium');
      if (h.last_7_days.volume < 5) flags.push(`thin market (${h.last_7_days.volume} sales/7d)`);
      const m30 = h.last_30_days.median;
      if (m30 && ref < m30 * 0.9) flags.push('7d median is >10% below 30d median — price is falling');
      if (edge > 0.25) flags.push('edge >25% — check float/pattern/stickers, may not be like-for-like');
      if (!it.market_hash_name.includes('|')) flags.push('base item (no skin) — pattern/float not comparable');
      out.push({
        name: key,
        ask,
        ref,
        sales7d: h.last_7_days.volume,
        sales30dMedian: m30,
        listings: it.quantity,
        edge,
        csfloatLow: null,
        csfloatEdge: null,
        flags,
        url: it.market_page || it.item_page,
        at: Date.now(),
      });
    }
    return out.sort((a, b) => b.edge - a.edge).slice(0, s.maxAlertsPerScan);
  }

  /** Second opinion from CSFloat for the candidates only (keeps API calls to a handful per scan). */
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
        d.flags.push('CSFloat check unavailable');
        continue;
      }
      d.csfloatLow = q.lowest;
      d.csfloatEdge = netEdge(d.ask, q.lowest, 'skinport', 'csfloat');
      if (q.lowest <= d.ask) d.flags.push('CSFloat has an equal or cheaper ask — Skinport price is not an outlier');
      else if (d.csfloatEdge < config.skins.minNetEdge) d.flags.push('would not clear the edge threshold if sold on CSFloat');
    }
  }

  /** Alerts are logged on day one so outcomes can be backtested later. */
  private record(d: Deal): void {
    appendJsonl(dailyFile(ALERT_PREFIX), d);
    this.pending.push({ name: d.name, ask: d.ask, ref: d.ref, edge: d.edge, alertedAt: d.at });
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
        // What selling at the later median would have netted vs the original ask.
        realizedEdge: med ? netEdge(p.ask, med, 'skinport', 'skinport') : null,
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

export function dealEmbed(d: Deal): EmbedBuilder {
  const v = VENUES.skinport;
  return new EmbedBuilder()
    .setColor(d.edge >= 0.15 ? 0x2ecc71 : 0xf1c40f)
    .setTitle(d.name.slice(0, 250))
    .setURL(d.url)
    .setDescription(`Net edge **${(d.edge * 100).toFixed(1)}%** after ${(v.sellFee * 100).toFixed(1)}% Skinport sell fee`)
    .addFields(
      { name: 'Skinport ask', value: usd(d.ask), inline: true },
      { name: '7d median sale', value: usd(d.ref), inline: true },
      { name: 'Sales 7d', value: String(d.sales7d), inline: true },
      { name: 'Listings', value: String(d.listings), inline: true },
      { name: '30d median', value: d.sales30dMedian ? usd(d.sales30dMedian) : 'n/a', inline: true },
      {
        name: 'CSFloat lowest ask',
        value: d.csfloatLow ? `${usd(d.csfloatLow)} (net ${(d.csfloatEdge! * 100).toFixed(1)}% if sold there)` : 'n/a',
        inline: true,
      },
      { name: 'Risk flags', value: d.flags.map((f) => `• ${f}`).join('\n').slice(0, 1000) },
    )
    .setFooter({ text: 'Read-only alert — not financial advice. Float/pattern not checked.' })
    .setTimestamp(d.at);
}
