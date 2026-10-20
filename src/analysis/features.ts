import type { Features } from '../types.js';
import type { TokenState } from '../state/tracker.js';
import type { CreatorStats } from './creators.js';
import { clamp, median, sum } from '../utils/math.js';

/**
 * pump.fun bonding-curve constants (UI units).
 * Curve starts at 1,073,000,000 virtual tokens; 793,100,000 real tokens are sold
 * along it, and the token graduates when they're gone.
 */
export const PUMP = {
  TOTAL_SUPPLY: 1_000_000_000,
  INITIAL_VTOKENS: 1_073_000_000,
  CURVE_TOKENS: 793_100_000,
};

export function curveProgressPct(vTokens: number): number {
  if (!vTokens) return 0;
  return clamp(((PUMP.INITIAL_VTOKENS - vTokens) / PUMP.CURVE_TOKENS) * 100, 0, 100);
}

const pct = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);

/** Everything outside the token itself that features depend on. Built once per engine tick. */
export interface FeatureContext {
  solUsd: number | null;
  sniperWindowSec: number;
  creator: (creator: string, launchTs: number) => CreatorStats;
  market: { launchesPerMin: number; graduations1h: number; solChange1hPct: number };
}

/** Buy sizes that repeat exactly (to 1e-6 SOL) ≥3 times among recent buys — scripted volume bots. */
function repeatSizePct(sizes: number[]): number {
  if (sizes.length < 5) return 0;
  const counts = new Map<string, number>();
  for (const x of sizes) {
    const k = x.toFixed(6); // lamport-level: humans using the same preset still differ here, scripted bots don't
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let rep = 0;
  for (const c of counts.values()) if (c >= 3) rep += c;
  return (rep / sizes.length) * 100;
}

export function computeFeatures(s: TokenState, now: number, ctx: FeatureContext): Features {
  const { solUsd, sniperWindowSec } = ctx;
  const ageSec = (now - s.createdAt) / 1000;
  const w5 = now - 300_000;
  const w2 = now - 120_000;
  const w1 = now - 60_000;

  // ── 5-minute flow window ───────────────────────────────────────────
  let buys5m = 0;
  let sells5m = 0;
  let buySol5m = 0;
  let sellSol5m = 0;
  const buyers5m = new Set<string>();
  const buySizes: number[] = [];
  for (let i = s.trades.length - 1; i >= 0; i--) {
    const t = s.trades[i];
    if (t.ts < w5) break;
    if (t.isBuy) {
      buys5m++;
      buySol5m += t.sol;
      buyers5m.add(t.wallet);
      buySizes.push(t.sol);
    } else {
      sells5m++;
      sellSol5m += t.sol;
    }
  }

  // ── Buyer velocity: first-time buyers, dev excluded ─────────────────
  let newLast2m = 0;
  let newLast1m = 0;
  let newPrev1m = 0;
  for (const [wallet, ts] of s.firstBuyAt) {
    if (wallet === s.creator || ts < w2) continue;
    newLast2m++;
    if (ts >= w1) newLast1m++;
    else newPrev1m++;
  }
  // Young tokens: divide by actual age so velocity isn't understated.
  const velWindowMin = clamp(ageSec / 60, 0.25, 2);

  // ── Holder distribution (stream-derived; on-chain check confirms later) ──
  const balances: number[] = [];
  let devBal = 0;
  let sniperBal = 0;
  for (const [wallet, bal] of s.balances) {
    if (bal <= 0) continue;
    balances.push(bal);
    if (wallet === s.creator) {
      devBal = bal;
      continue;
    }
    const fb = s.firstBuyAt.get(wallet);
    if (fb !== undefined && fb - s.createdAt <= sniperWindowSec * 1000) sniperBal += bal;
  }
  balances.sort((a, b) => b - a);

  // ── Volume concentration / churn ───────────────────────────────────
  const vols = [...s.walletVol.values()].sort((a, b) => b - a);
  let washVol = 0;
  for (const [wallet, v] of s.walletVol) {
    if ((s.walletBuys.get(wallet) ?? 0) >= 2 && (s.walletSells.get(wallet) ?? 0) >= 2) washVol += v;
  }

  const netFlow = buySol5m - sellSol5m;
  const cr = ctx.creator(s.creator, s.createdAt);
  const uniqueBuyers = s.firstBuyAt.size - (s.firstBuyAt.has(s.creator) ? 1 : 0);

  return {
    ageSec,
    mcapSol: s.mcapSol,
    mcapUsd: solUsd ? s.mcapSol * solUsd : null,
    curvePct: curveProgressPct(s.vTokens),
    uniqueBuyers,
    holders: balances.length,
    buyers5m: buyers5m.size,
    newBuyersPerMin: newLast2m / velWindowMin,
    buyerAccel: newLast1m - newPrev1m,
    buys5m,
    sells5m,
    buyCountPct5m: pct(buys5m, buys5m + sells5m),
    buySolPct5m: pct(buySol5m, buySol5m + sellSol5m),
    volSol5m: buySol5m + sellSol5m,
    netFlowSol5m: netFlow,
    netFlowRelPct: pct(netFlow, s.mcapSol),
    medianBuySol5m: median(buySizes),
    top10Pct: pct(sum(balances.slice(0, 10)), PUMP.TOTAL_SUPPLY),
    maxHolderPct: pct(balances[0] ?? 0, PUMP.TOTAL_SUPPLY),
    devPct: pct(devBal, PUMP.TOTAL_SUPPLY),
    devSoldPct: s.devPeak > 0 ? clamp(pct(s.devPeak - devBal, s.devPeak), 0, 100) : 0,
    sniperPct: pct(sniperBal, PUMP.TOTAL_SUPPLY),
    volConcTop3Pct: s.totalVolSol > 0 ? pct(sum(vols.slice(0, 3)), s.totalVolSol) : 100,
    washPct: pct(washVol, s.totalVolSol),
    drawdownPct: s.peakMcapSol > 0 ? clamp((1 - s.mcapSol / s.peakMcapSol) * 100, 0, 100) : 0,
    tickerDupes: s.tickerDupes,
    repeatSizePct5m: repeatSizePct(buySizes),
    creatorPriorLaunches: cr.priorLaunches,
    creatorLaunches24h: cr.launches24h,
    creatorPriorGraduated: cr.priorGraduated,
    creatorBestPriorPeakSol: cr.bestPriorPeakSol,
    creatorMinSinceLast: cr.minSinceLast,
    launchesPerMin: ctx.market.launchesPerMin,
    graduations1h: ctx.market.graduations1h,
    solChange1hPct: ctx.market.solChange1hPct,
  };
}
