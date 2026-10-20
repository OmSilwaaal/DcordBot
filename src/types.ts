export interface CreateEvent {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  bondingCurveKey: string;
  pool: string;
  initialBuyTokens: number;
  initialBuySol: number;
  vTokens: number;
  vSol: number;
  mcapSol: number;
  signature: string;
  receivedAt: number;
}

export interface TradeEvent {
  mint: string;
  wallet: string;
  isBuy: boolean;
  tokens: number;
  sol: number;
  newBalance: number;
  vTokens: number;
  vSol: number;
  mcapSol: number;
  signature: string;
  receivedAt: number;
}

export interface MigrateEvent {
  mint: string;
  pool: string;
  signature: string;
  receivedAt: number;
}

/** Feature snapshot of one token at one moment. `...Pct` fields are 0–100. */
export interface Features {
  ageSec: number;
  mcapSol: number;
  mcapUsd: number | null;
  curvePct: number;
  uniqueBuyers: number;
  holders: number;
  buyers5m: number;
  /** First-time buyers per minute over the last 2 minutes (dev excluded). */
  newBuyersPerMin: number;
  /** First-time buyers in the last 60s minus the 60s before that. */
  buyerAccel: number;
  buys5m: number;
  sells5m: number;
  buyCountPct5m: number;
  buySolPct5m: number;
  volSol5m: number;
  netFlowSol5m: number;
  /** 5m net inflow as % of market cap — inflow relative to size. */
  netFlowRelPct: number;
  medianBuySol5m: number;
  top10Pct: number;
  maxHolderPct: number;
  devPct: number;
  devSoldPct: number;
  sniperPct: number;
  /** Share of all-time SOL volume from the 3 most active wallets. */
  volConcTop3Pct: number;
  /** Share of volume from wallets with ≥2 buys AND ≥2 sells (churners/wash). */
  washPct: number;
  drawdownPct: number;
  tickerDupes: number;
  /** % of 5m buys whose exact size repeats ≥3 times (volume-bot signature). */
  repeatSizePct5m: number;

  // Creator history (from launches this bot has seen; grows over time)
  creatorPriorLaunches: number;
  creatorLaunches24h: number;
  creatorPriorGraduated: number;
  creatorBestPriorPeakSol: number;
  /** Minutes since the creator's previous launch; -1 if none seen. */
  creatorMinSinceLast: number;

  // Market conditions
  launchesPerMin: number;
  graduations1h: number;
  solChange1hPct: number;
}

/** Early-buyer forensics, computed at verify time on a sample of top holders + earliest buyers. */
export interface WalletAnalysis {
  ok: boolean;
  error?: string;
  sampled: number;
  /** Wallets whose full history fits in the fetch window and started < FRESH_WALLET_HOURS ago. */
  freshPct: number;
  /** Wallets with fewer than 10 transactions ever. */
  lowActivityPct: number;
  /** Groups of ≥2 sampled wallets funded by the same (non-exchange) wallet. */
  clusters: number;
  largestCluster: number;
  clusterWallets: number;
  clusterHoldPct: number;
  /** Sampled buyers funded directly by the token's creator. */
  devFundedBuyers: number;
}

export interface DexOrders {
  ok: boolean;
  paidProfile: boolean;
  communityTakeover: boolean;
  ads: number;
  boosts: number;
  /** Minutes from launch to the first paid order; -1 if none. */
  minToFirstPaid: number;
}

export interface XMentions {
  ok: boolean;
  skipped?: string;
  posts: number;
  capped: boolean;
  authors: number;
  medianFollowers: number;
  newAccountPct: number;
}

export interface TokenMetadata {
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface ScoreParts {
  velocity: number;
  flow: number;
  pressure: number;
  distribution: number;
  organic: number;
  socials: number;
  ticker: number;
}

export interface ScoreResult {
  total: number;
  tier: 'A' | 'B' | 'C';
  parts: ScoreParts;
}

export interface OnchainCheck {
  ok: boolean;
  error?: string;
  tokenProgram?: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  dangerousExtensions: string[];
  top10Pct: number;
  maxHolderPct: number;
}

export interface RugcheckResult {
  status: 'ok' | 'not_found' | 'unavailable';
  score?: number;
  scoreNormalised?: number;
  dangers: string[];
  warnings: string[];
}

export interface PerfState {
  samples: number;
  lastMult: number;
  peakMult: number;
  peakAtMin: number;
  troughMult: number;
  checkpoints: Record<string, number | null>;
  graduated: boolean;
  lastUpdate: number;
  sim: {
    open: boolean;
    exitReason: 'tp' | 'sl' | 'time' | null;
    exitMult: number | null;
    returnPct: number | null;
  };
}

export interface SignalRecord {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  signaledAt: number;
  score: number;
  tier: ScoreResult['tier'];
  parts: ScoreParts;
  features: Features;
  onchain: OnchainCheck | null;
  rugcheck: RugcheckResult;
  socials: TokenMetadata | null;
  wallets?: WalletAnalysis | null;
  dexOrders?: DexOrders | null;
  x?: XMentions | null;
  entryMcapUsd: number;
  solPriceAtSignal: number;
  messageId?: string;
  perf: PerfState;
  finalizedAt?: number;
}
