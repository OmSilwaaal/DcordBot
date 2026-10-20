import { fetchJson } from '../utils/http.js';
import { log } from '../utils/logger.js';
import { getPairs, WSOL } from './dexscreener.js';

/** SOL/USD, refreshed every minute. CoinGecko first, DexScreener SOL/stablecoin pair as fallback. */
export class SolPriceFeed {
  value: number | null = null;
  updatedAt = 0;
  /** [time, price] samples for the last ~2h. */
  private history: [number, number][] = [];
  private timer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60_000);
  }

  /** % change vs the sample closest to 1h ago (0 until an hour of history exists). */
  change1hPct(): number {
    if (!this.value || this.history.length < 2) return 0;
    const target = Date.now() - 3_600_000;
    const [t0, p0] = this.history[0];
    if (t0 > target + 10 * 60_000) return 0;
    let best: [number, number] = [t0, p0];
    for (const h of this.history) if (Math.abs(h[0] - target) < Math.abs(best[0] - target)) best = h;
    return ((this.value - best[1]) / best[1]) * 100;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    let price: number | undefined;

    const cg = await fetchJson<{ solana?: { usd?: number } }>(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeoutMs: 6000, retries: 1 },
    );
    price = cg.ok ? cg.data?.solana?.usd : undefined;

    if (!price) {
      const stable = (await getPairs([WSOL]))
        .filter((p) => p.baseToken?.address === WSOL && ['USDC', 'USDT'].includes(p.quoteToken?.symbol))
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      price = stable?.priceUsd ? Number(stable.priceUsd) : undefined;
    }

    if (price && price > 0) {
      this.value = price;
      this.updatedAt = Date.now();
      this.history.push([this.updatedAt, price]);
      this.history = this.history.filter(([t]) => this.updatedAt - t < 2 * 3_600_000);
    } else {
      log.warn('[sol] price refresh failed, keeping last value');
    }
  }
}
