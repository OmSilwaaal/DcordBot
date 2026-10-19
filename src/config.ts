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
  },

  feeds: {
    pumpPortalWs: str('PUMPPORTAL_WS', 'wss://pumpportal.fun/api/data'),
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

    onchainMaxTop10Pct: num('ONCHAIN_MAX_TOP10_PCT', 35),
    onchainMaxSingleHolderPct: num('ONCHAIN_MAX_SINGLE_HOLDER_PCT', 10),
    /** If the RPC check can't run, hold the signal and retry (true) or send it marked unverified (false). */
    requireOnchain: bool('REQUIRE_ONCHAIN', true),
    /** RugCheck is supplementary; a "danger" flag always rejects, but an unavailable API only blocks if true. */
    requireRugcheck: bool('REQUIRE_RUGCHECK', false),
    /** RugCheck risk names containing these substrings are ignored (LP/liquidity flags don't apply on a bonding curve). */
    rugcheckIgnore: list('RUGCHECK_IGNORE', ['lp', 'liquidity']).map((s) => s.toLowerCase()),
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

  healthPort: num('HEALTH_PORT', 8080),
};

export type Config = typeof config;
