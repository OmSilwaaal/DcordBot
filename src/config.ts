import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function str(key: string, def: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : def;
}

function num(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${key} must be a number, got "${v}"`);
  return n;
}

function bool(key: string, def: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(key: string, def: string[]): string[] {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  discord: {
    token: str('DISCORD_TOKEN', ''),
    channelId: str('DISCORD_CHANNEL_ID', ''),
    /** Set this to register slash commands instantly in one server. */
    guildId: str('DISCORD_GUILD_ID', ''),
    /** Post "radar online" to the channel on every boot — instant proof the Discord side works. */
    startupMessage: bool('STARTUP_MESSAGE', true),
  },

  feeds: {
    pumpPortalWs: str('PUMPPORTAL_WS', 'wss://pumpportal.fun/api/data'),
    /**
     * Where trades come from. 'pumpportal' needs PUMPPORTAL_WS with a funded ?api-key=…;
     * 'chain' decodes pump.fun trades from a Solana websocket instead (free).
     */
    tradeSource: ((): 'pumpportal' | 'chain' => {
      const v = str('TRADE_SOURCE', '').toLowerCase();
      if (v === 'pumpportal' || v === 'chain') return v;
      return /api-key=/i.test(process.env.PUMPPORTAL_WS ?? '') ? 'pumpportal' : 'chain';
    })(),
    /** Solana websocket for the chain trade stream. ~40 MB/min, so a metered RPC plan can run out fast. */
    solanaWsUrl: str('SOLANA_WS_URL', 'wss://api.mainnet-beta.solana.com'),
    /** Overlapping sockets for the chain stream; the public endpoint drops each one every ~30s. */
    solanaWsConnections: num('SOLANA_WS_CONNECTIONS', 3),
    /** Use a real provider (Helius/QuickNode/Triton). The public endpoint often rejects getTokenLargestAccounts. */
    rpcUrl: str('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
    rpcRps: num('RPC_RPS', 4),
    /** PumpPortal launchpads to track. Curve math in features.ts is pump.fun-specific. */
    allowedPools: list('ALLOWED_POOLS', ['pump']),
  },

  tracking: {
    /** Stop watching a token that hasn't signaled after this long. */
    watchWindowMin: num('WATCH_WINDOW_MIN', 20),
    /** Drop a token with no trades for this long (after its first 2 minutes). */
    deadAfterSec: num('DEAD_AFTER_SEC', 180),
    maxTracked: num('MAX_TRACKED', 2000),
    evalIntervalMs: num('EVAL_INTERVAL_MS', 2000),
    /** Buyers within this many seconds of creation count as snipers. */
    sniperWindowSec: num('SNIPER_WINDOW_SEC', 3),
    /** Window for counting same-ticker launches (copycat detection). */
    tickerWindowMin: num('TICKER_WINDOW_MIN', 60),
    verifyConcurrency: num('VERIFY_CONCURRENCY', 3),
  },

  /** Hard gates. `...Pct` values are 0–100. */
  gates: {
    minAgeSec: num('MIN_AGE_SEC', 45),
    minCurvePct: num('MIN_CURVE_PCT', 8),
    maxCurvePct: num('MAX_CURVE_PCT', 85),
    minUniqueBuyers: num('MIN_UNIQUE_BUYERS', 25),
    minBuyers5m: num('MIN_BUYERS_5M', 15),
    minBuyCountPct5m: num('MIN_BUY_COUNT_PCT_5M', 55),
    minNetFlowSol5m: num('MIN_NET_FLOW_SOL_5M', 2),
    maxTop10Pct: num('MAX_TOP10_PCT', 30),
    maxSingleHolderPct: num('MAX_SINGLE_HOLDER_PCT', 8),
    maxDevPct: num('MAX_DEV_PCT', 8),
    /** % of the dev's peak bag sold before the token is permanently rejected. 0 = any dev sell. */
    maxDevSellPct: num('MAX_DEV_SELL_PCT', 0),
    maxSniperPct: num('MAX_SNIPER_PCT', 15),
    maxVolConcTop3Pct: num('MAX_VOL_CONC_TOP3_PCT', 50),
    maxWashPct: num('MAX_WASH_PCT', 30),
    maxDrawdownPct: num('MAX_DRAWDOWN_PCT', 35),
    maxTickerDupes: num('MAX_TICKER_DUPES', 3),
    /** Serial-launcher cap: creator launches in the last 24h (this one excluded). Off by default — log first. */
    maxCreatorLaunches24h: num('MAX_CREATOR_LAUNCHES_24H', 1000),

    onchainMaxTop10Pct: num('ONCHAIN_MAX_TOP10_PCT', 35),
    onchainMaxSingleHolderPct: num('ONCHAIN_MAX_SINGLE_HOLDER_PCT', 10),
    /** If the RPC check can't run, hold the signal and retry (true) or send it marked unverified (false). */
    requireOnchain: bool('REQUIRE_ONCHAIN', true),
    /** RugCheck is supplementary; a "danger" flag always rejects, but an unavailable API only blocks if true. */
    requireRugcheck: bool('REQUIRE_RUGCHECK', false),
    /** RugCheck risk names containing these substrings are ignored (LP/liquidity flags don't apply on a bonding curve). */
    rugcheckIgnore: list('RUGCHECK_IGNORE', ['lp', 'liquidity']).map((s) => s.toLowerCase()),

    // Wallet-analysis gates (verify stage). Defaults are OFF (log-only) until the data shows where to set them.
    maxFreshWalletPct: num('MAX_FRESH_WALLET_PCT', 100),
    maxClusterHoldPct: num('MAX_CLUSTER_HOLD_PCT', 100),
    maxDevFundedBuyers: num('MAX_DEV_FUNDED_BUYERS', 1000),
  },

  /** Early-buyer forensics at verify time: wallet age + who funded each wallet. Costs ~20–45 RPC calls per candidate. */
  wallets: {
    enabled: bool('WALLET_ANALYSIS', true),
    sample: num('WALLET_SAMPLE', 20),
    freshHours: num('FRESH_WALLET_HOURS', 24),
    /** Signatures fetched per wallet. Fewer than this = full history seen, so age and funder are known. */
    historyLimit: num('WALLET_HISTORY_LIMIT', 100),
    /** A funder with ≥ this many txs is treated as an exchange/service, not a cluster. */
    busyFunderTxs: num('BUSY_FUNDER_TXS', 1000),
  },

  dexOrders: {
    enabled: bool('DEX_ORDERS', true),
  },

  /**
   * X (Twitter) mentions of the contract address. Two sources:
   *  - 'api'    official X API (X_BEARER_TOKEN), billed per post read
   *  - 'scrape' rettiwt-api logged in as an X account (X_SCRAPE_API_KEY), free but against X's terms:
   *             use a throwaway account, expect it to get limited or suspended eventually
   * X_MODE defaults to whichever credential is set (api wins if both are), else off.
   */
  x: {
    mode: (() => {
      const m = str('X_MODE', '').toLowerCase();
      if (m === 'api' || m === 'scrape' || m === 'off') return m;
      return process.env.X_BEARER_TOKEN ? 'api' : process.env.X_SCRAPE_API_KEY ? 'scrape' : 'off';
    })() as 'api' | 'scrape' | 'off',
    bearerToken: str('X_BEARER_TOKEN', ''),
    scrapeApiKey: str('X_SCRAPE_API_KEY', ''),
    /** Searches per day. Defaults: 20 on the paid API, 150 when scraping. */
    maxCallsPerDay: num('X_MAX_CALLS_PER_DAY', process.env.X_BEARER_TOKEN && str('X_MODE', '') !== 'scrape' ? 20 : 150),
    maxResults: num('X_MAX_RESULTS', 10),
    /** Optional proxy for scrape mode, e.g. http://user:pass@host:port. */
    scrapeProxy: str('X_SCRAPE_PROXY', ''),
  },

  scoring: {
    minScore: num('MIN_SCORE', 60),
    tierA: num('TIER_A', 80),
    tierB: num('TIER_B', 70),
    /** New unique buyers per minute that earns full velocity points. */
    velocityTarget: num('VELOCITY_TARGET', 12),
    /** 5m net SOL inflow as % of market cap that earns full flow points. */
    flowTargetPct: num('FLOW_TARGET_PCT', 25),
  },

  /** Trade plan shown in each signal and forward-tested by the performance tracker. */
  plan: {
    stopLossPct: num('PLAN_STOP_LOSS_PCT', 35),
    takeProfitMult: num('PLAN_TAKE_PROFIT_MULT', 2),
    timeStopMin: num('PLAN_TIME_STOP_MIN', 60),
    /** Assumed entry worse than the signal price (latency + curve slippage). */
    entrySlippagePct: num('PLAN_ENTRY_SLIPPAGE_PCT', 5),
    /** Fees + priority fees + exit slippage, round trip. */
    roundTripCostPct: num('PLAN_ROUND_TRIP_COST_PCT', 3),
  },

  limits: {
    maxSignalsPerHour: num('MAX_SIGNALS_PER_HOUR', 20),
  },

  dataset: {
    enabled: bool('DATASET_ENABLED', true),
    /** Ages (seconds) at which every tracked token's features are snapshotted for analysis. */
    snapshotAgesSec: list('SNAPSHOT_AGES_SEC', ['60', '180', '300']).map(Number).filter(Number.isFinite),
  },

  /** Railway (and most PaaS) inject PORT; HEALTH_PORT overrides it. */
  healthPort: num('HEALTH_PORT', num('PORT', 8080)),
};

export type Config = typeof config;
