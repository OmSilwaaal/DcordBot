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

export interface ShadowPlan {
  name: string;
  /** null = no target. */
  takeProfitMult: number | null;
  stopLossPct: number;
  /** Trailing stop distance below the high since entry; null = none. */
  trailPct: number | null;
  timeStopMin: number;
}

/** "name:tp:sl:trail:min" with 0 meaning none for tp and trail, e.g. "trail10:0:35:10:60". */
function shadowPlans(key: string, def: string[]): ShadowPlan[] {
  return list(key, def).map((spec) => {
    const [name, ...rest] = spec.split(':');
    const [tp, sl, trail, min] = rest.map(Number);
    if (!name || rest.length !== 4 || ![tp, sl, trail, min].every(Number.isFinite))
      throw new Error(`Env var ${key}: bad plan "${spec}", expected name:tp:sl:trail:min`);
    return { name, takeProfitMult: tp || null, stopLossPct: sl, trailPct: trail || null, timeStopMin: min };
  });
}

export const config = {
  discord: {
    token: str('DISCORD_TOKEN', ''),
    channelId: str('DISCORD_CHANNEL_ID', ''),
    /** Set this to register slash commands instantly in one server. */
    guildId: str('DISCORD_GUILD_ID', ''),
    /** Your Discord user ID. Enables the owner-only /export command (attaches the bot's data logs). */
    ownerId: str('OWNER_ID', ''),
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

    // Wallet-intelligence gates (stream stage). Also OFF (log-only) until the dataset shows where to set them.
    maxLaunchBlockHoldPct: num('MAX_LAUNCH_BLOCK_HOLD_PCT', 100),
    maxSlotClusterHoldPct: num('MAX_SLOT_CLUSTER_HOLD_PCT', 100),
    maxEarlyBuyersSoldPct: num('MAX_EARLY_BUYERS_SOLD_PCT', 100),
    maxFlipperHoldPct: num('MAX_FLIPPER_HOLD_PCT', 100),
    maxSerialSniperHoldPct: num('MAX_SERIAL_SNIPER_HOLD_PCT', 100),
    maxProfitableBuyers: num('MAX_PROFITABLE_BUYERS', 1000),
    maxLoserBuyers1m: num('MAX_LOSER_BUYERS_1M', 1000),
  },

  /**
   * Wallet book: every wallet's past positions on tokens the bot tracked, used to classify
   * the buyers of new tokens. Built from the trade stream, so it costs no RPC calls.
   */
  walletBook: {
    /** Positions a wallet needs before it's classified at all. */
    minPositions: num('WALLET_MIN_POSITIONS', 3),
    /** Profitable trader: at least this many positions, win rate and total profit. */
    profitableMinPositions: num('WALLET_PROFITABLE_MIN_POSITIONS', 5),
    profitableMinWinPct: num('WALLET_PROFITABLE_MIN_WIN_PCT', 50),
    profitableMinPnlSol: num('WALLET_PROFITABLE_MIN_PNL_SOL', 1),
    /** Habitual loser: at least this many positions, a win rate below this, and a net loss. */
    loserMinPositions: num('WALLET_LOSER_MIN_POSITIONS', 5),
    loserMaxWinPct: num('WALLET_LOSER_MAX_WIN_PCT', 30),
    /**
     * Flipper: sells within this many seconds of first buying on at least this share of positions.
     * 120s / 50% separated outcomes better than 60s / 70% in the Oct 21 backfill.
     */
    flipSec: num('WALLET_FLIP_SEC', 120),
    flipperMinPct: num('WALLET_FLIPPER_MIN_PCT', 50),
    /** Serial sniper: first buy within 2 blocks (or 3s) of launch on at least this share of positions. */
    sniperMinPct: num('WALLET_SNIPER_MIN_PCT', 50),
    /** Positions smaller than this are dust and aren't recorded. */
    minPositionSol: num('WALLET_MIN_POSITION_SOL', 0.01),
    /**
     * Only record positions on tokens that reached this many unique buyers. Dead tokens are mostly
     * bots buying and selling within seconds, which labels far too many wallets as flippers; the
     * backfill (which the gate thresholds were fitted on) only covers tokens with 20+ buyers.
     */
    minTokenBuyers: num('WALLET_BOOK_MIN_TOKEN_BUYERS', 20),
    maxWallets: num('WALLET_BOOK_MAX', 400_000),
    keepDays: num('WALLET_BOOK_KEEP_DAYS', 14),
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
    /**
     * Alternative exits forward-tested on the same signals, for comparison only (alerts show the main plan).
     * Backtests on 15s price paths favored a trailing stop and quick exits, but couldn't resolve stop fills.
     */
    shadow: shadowPlans('SHADOW_EXIT_PLANS', ['trail10:0:35:10:60', 'trail20:0:35:20:60', 'quick2m:3:10:0:2', 'tp1.5:1.5:15:0:10']),
  },

  limits: {
    maxSignalsPerHour: num('MAX_SIGNALS_PER_HOUR', 20),
  },

  dataset: {
    enabled: bool('DATASET_ENABLED', true),
    /** Ages (seconds) at which every tracked token's features are snapshotted for analysis. */
    snapshotAgesSec: list('SNAPSHOT_AGES_SEC', ['60', '180', '300']).map(Number).filter(Number.isFinite),
  },

  /** CS2 skin/knife deal alerts (read-only; never buys anything). Fees live in skins/fees.ts. */
  skins: {
    enabled: bool('SKINS_ENABLED', false),
    /** Own channel, e.g. #skin-deals. */
    channelId: str('SKINS_CHANNEL_ID', ''),
    /** Skinport caches /items and /sales/history for 5 minutes, so polling faster gains nothing. */
    intervalMin: Math.max(5, num('SKINS_INTERVAL_MIN', 5)),
    /** Alert threshold as a fraction: 0.05 = 5% net of fees. */
    minNetEdge: num('SKINS_MIN_NET_EDGE', 0.05),
    /** Optional CSFloat API key (free, from your CSFloat profile). Enables a second price check. */
    csfloatKey: str('CSFLOAT_API_KEY', ''),
    /** Chinese markets trade a few % below the West; only flag a gap beyond this fraction. */
    chinaBuffer: num('SKINS_CHINA_BUFFER', 0.1),
    /** Edges above this are discarded as mismatched comparisons. */
    maxNetEdge: num('SKINS_MAX_NET_EDGE', 0.6),
    /** Reference price needs at least this many sales in 7 days. */
    minSales7d: num('SKINS_MIN_SALES_7D', 3),
    minPrice: num('SKINS_MIN_PRICE', 20),
    maxPrice: num('SKINS_MAX_PRICE', 2000),
    knivesOnly: bool('SKINS_KNIVES_ONLY', true),
    maxAlertsPerScan: num('SKINS_MAX_ALERTS_PER_SCAN', 5),
    /** Days after an alert before its outcome is logged for backtesting. */
    outcomeDays: num('SKINS_OUTCOME_DAYS', 7),
  },

  /** Railway (and most PaaS) inject PORT; HEALTH_PORT overrides it. */
  healthPort: num('HEALTH_PORT', num('PORT', 8080)),
};

export type Config = typeof config;
