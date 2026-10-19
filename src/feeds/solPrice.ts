import { fetchJson } from '../utils/http.js';
import { log } from '../utils/logger.js';
import { getPairs, WSOL } from './dexscreener.js';

/** SOL/USD, refreshed every minute. CoinGecko first, DexScreener SOL/stablecoin pair as fallback. */
export class SolPriceFeed {
  value: number | null = null;
  updatedAt = 0;
  private timer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60_000);
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
    } else {
      log.warn('[sol] price refresh failed, keeping last value');
    }
  }
}
