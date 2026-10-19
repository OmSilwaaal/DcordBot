import { config } from '../config.js';
import type { Features, ScoreResult, TokenMetadata } from '../types.js';
import { clamp } from '../utils/math.js';

export const SOCIAL_MAX = 5;

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * 0–100 ranking score for tokens that already passed the hard gates.
 * Weights are priors, not fitted values — run `npm run analyze` on collected
 * data and re-weight toward the features that actually separate winners.
 */
export function computeScore(
  f: Features,
  meta: TokenMetadata | null,
  s = config.scoring,
  g = config.gates,
): ScoreResult {
  const parts = {
    // Demand: new wallets arriving
    velocity: r1(25 * clamp(f.newBuyersPerMin / s.velocityTarget, 0, 1)),
    // Capital: net SOL in, relative to size (5 SOL means more at 40 SOL mcap than at 300)
    flow: r1(20 * clamp(f.netFlowRelPct / s.flowTargetPct, 0, 1)),
    // Pressure: SOL-weighted buy share above 50%
    pressure: r1(15 * clamp((f.buySolPct5m - 50) / 30, 0, 1)),
    // Supply: less concentrated = less dump overhang
    distribution: r1(
      12 * (1 - clamp(f.top10Pct / g.maxTop10Pct, 0, 1)) + 8 * (1 - clamp(f.sniperPct / g.maxSniperPct, 0, 1)),
    ),
    // Organic: volume spread across many wallets, little churn
    organic: r1(6 * (1 - clamp((f.volConcTop3Pct - 15) / 40, 0, 1)) + 4 * (1 - clamp(f.washPct / 40, 0, 1))),
    socials: meta ? (meta.twitter ? 2 : 0) + (meta.telegram ? 1 : 0) + (meta.website ? 2 : 0) : 0,
    // Originals outperform the copycats that follow them
    ticker: [5, 3, 1][f.tickerDupes] ?? 0,
  };
  const total = Math.round(Object.values(parts).reduce((a, b) => a + b, 0));
  const tier = total >= s.tierA ? 'A' : total >= s.tierB ? 'B' : 'C';
  return { total, tier, parts };
}
