import { config } from '../config.js';
import type { Features } from '../types.js';

export type GateResult = { pass: true } | { pass: false; reason: string; permanent: boolean };

const fail = (reason: string, permanent = false): GateResult => ({ pass: false, reason, permanent });
const p = (x: number) => x.toFixed(1);

/**
 * Hard gates on stream-derived features.
 * Permanent failures stop tracking the token; everything else is a "not yet"
 * and is re-checked on the next trade, so a token that's thin at minute 1 can
 * still signal at minute 4 (the original bot cached it as seen and never looked again).
 */
export function checkGates(f: Features, g = config.gates): GateResult {
  if (f.devSoldPct > g.maxDevSellPct) return fail(`dev sold ${p(f.devSoldPct)}% of bag`, true);
  if (f.tickerDupes > g.maxTickerDupes) return fail(`copycat ticker (${f.tickerDupes} earlier launches)`, true);

  if (f.ageSec < g.minAgeSec) return fail('too young');
  if (f.curvePct < g.minCurvePct) return fail(`curve ${p(f.curvePct)}% < ${g.minCurvePct}%`);
  if (f.curvePct > g.maxCurvePct) return fail(`curve ${p(f.curvePct)}% > ${g.maxCurvePct}%`);
  if (f.uniqueBuyers < g.minUniqueBuyers) return fail(`buyers ${f.uniqueBuyers} < ${g.minUniqueBuyers}`);
  if (f.buyers5m < g.minBuyers5m) return fail(`5m buyers ${f.buyers5m} < ${g.minBuyers5m}`);
  if (f.buyCountPct5m < g.minBuyCountPct5m) return fail(`5m buy share ${p(f.buyCountPct5m)}%`);
  if (f.netFlowSol5m < g.minNetFlowSol5m) return fail(`5m net flow ${f.netFlowSol5m.toFixed(2)} SOL`);
  if (f.top10Pct > g.maxTop10Pct) return fail(`top10 ${p(f.top10Pct)}%`);
  if (f.maxHolderPct > g.maxSingleHolderPct) return fail(`max holder ${p(f.maxHolderPct)}%`);
  if (f.devPct > g.maxDevPct) return fail(`dev holds ${p(f.devPct)}%`);
  if (f.sniperPct > g.maxSniperPct) return fail(`snipers hold ${p(f.sniperPct)}%`);
  if (f.volConcTop3Pct > g.maxVolConcTop3Pct) return fail(`top3 wallets = ${p(f.volConcTop3Pct)}% of volume`);
  if (f.washPct > g.maxWashPct) return fail(`churn volume ${p(f.washPct)}%`);
  if (f.drawdownPct > g.maxDrawdownPct) return fail(`${p(f.drawdownPct)}% off peak`);
  return { pass: true };
}
