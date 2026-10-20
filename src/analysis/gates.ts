import { config } from '../config.js';
import type { Features } from '../types.js';

export type GateResult = { pass: true } | { pass: false; key: string; reason: string; permanent: boolean };

type Gates = typeof config.gates;

interface Gate {
  key: string;
  /** Plain-English label for /funnel. */
  label: (g: Gates) => string;
  /** Returns a failure reason, or null if the token passes. */
  test: (f: Features, g: Gates) => string | null;
  permanent?: boolean;
  /** Time-based gates every token fails at first; excluded from near-miss accounting. */
  temporal?: boolean;
}

const p = (x: number) => x.toFixed(1);

/**
 * Hard gates on stream-derived features, in evaluation order.
 * Permanent failures stop tracking the token; everything else is a "not yet"
 * and is re-checked on the next trade.
 */
export const GATES: Gate[] = [
  {
    key: 'devSold',
    permanent: true,
    label: (g) => `dev sold > ${g.maxDevSellPct}% of bag`,
    test: (f, g) => (f.devSoldPct > g.maxDevSellPct ? `dev sold ${p(f.devSoldPct)}% of bag` : null),
  },
  {
    key: 'copycat',
    permanent: true,
    label: (g) => `> ${g.maxTickerDupes} earlier same-ticker launches`,
    test: (f, g) => (f.tickerDupes > g.maxTickerDupes ? `copycat ticker (${f.tickerDupes} earlier launches)` : null),
  },
  {
    key: 'age',
    temporal: true,
    label: (g) => `age < ${g.minAgeSec}s`,
    test: (f, g) => (f.ageSec < g.minAgeSec ? 'too young' : null),
  },
  {
    key: 'curveLow',
    label: (g) => `curve < ${g.minCurvePct}%`,
    test: (f, g) => (f.curvePct < g.minCurvePct ? `curve ${p(f.curvePct)}% < ${g.minCurvePct}%` : null),
  },
  {
    key: 'curveHigh',
    label: (g) => `curve > ${g.maxCurvePct}%`,
    test: (f, g) => (f.curvePct > g.maxCurvePct ? `curve ${p(f.curvePct)}% > ${g.maxCurvePct}%` : null),
  },
  {
    key: 'buyers',
    label: (g) => `unique buyers < ${g.minUniqueBuyers}`,
    test: (f, g) => (f.uniqueBuyers < g.minUniqueBuyers ? `buyers ${f.uniqueBuyers} < ${g.minUniqueBuyers}` : null),
  },
  {
    key: 'buyers5m',
    label: (g) => `5m buyers < ${g.minBuyers5m}`,
    test: (f, g) => (f.buyers5m < g.minBuyers5m ? `5m buyers ${f.buyers5m} < ${g.minBuyers5m}` : null),
  },
  {
    key: 'buyShare',
    label: (g) => `5m buy share < ${g.minBuyCountPct5m}%`,
    test: (f, g) => (f.buyCountPct5m < g.minBuyCountPct5m ? `5m buy share ${p(f.buyCountPct5m)}%` : null),
  },
  {
    key: 'netFlow',
    label: (g) => `5m net flow < ${g.minNetFlowSol5m} SOL`,
    test: (f, g) => (f.netFlowSol5m < g.minNetFlowSol5m ? `5m net flow ${f.netFlowSol5m.toFixed(2)} SOL` : null),
  },
  {
    key: 'top10',
    label: (g) => `top10 > ${g.maxTop10Pct}%`,
    test: (f, g) => (f.top10Pct > g.maxTop10Pct ? `top10 ${p(f.top10Pct)}%` : null),
  },
  {
    key: 'maxHolder',
    label: (g) => `max holder > ${g.maxSingleHolderPct}%`,
    test: (f, g) => (f.maxHolderPct > g.maxSingleHolderPct ? `max holder ${p(f.maxHolderPct)}%` : null),
  },
  {
    key: 'devHold',
    label: (g) => `dev holds > ${g.maxDevPct}%`,
    test: (f, g) => (f.devPct > g.maxDevPct ? `dev holds ${p(f.devPct)}%` : null),
  },
  {
    key: 'snipers',
    label: (g) => `snipers hold > ${g.maxSniperPct}%`,
    test: (f, g) => (f.sniperPct > g.maxSniperPct ? `snipers hold ${p(f.sniperPct)}%` : null),
  },
  {
    key: 'volConc',
    label: (g) => `top3 wallets > ${g.maxVolConcTop3Pct}% of volume`,
    test: (f, g) => (f.volConcTop3Pct > g.maxVolConcTop3Pct ? `top3 wallets = ${p(f.volConcTop3Pct)}% of volume` : null),
  },
  {
    key: 'churn',
    label: (g) => `churn volume > ${g.maxWashPct}%`,
    test: (f, g) => (f.washPct > g.maxWashPct ? `churn volume ${p(f.washPct)}%` : null),
  },
  {
    key: 'drawdown',
    label: (g) => `> ${g.maxDrawdownPct}% off peak`,
    test: (f, g) => (f.drawdownPct > g.maxDrawdownPct ? `${p(f.drawdownPct)}% off peak` : null),
  },
];

export const GATE_BY_KEY = new Map(GATES.map((g) => [g.key, g]));

/** First failing gate (used for the actual decision). */
export function checkGates(f: Features, g = config.gates): GateResult {
  for (const gate of GATES) {
    const reason = gate.test(f, g);
    if (reason) return { pass: false, key: gate.key, reason, permanent: !!gate.permanent };
  }
  return { pass: true };
}

/** Every failing non-temporal gate — used to find which gate is the real bottleneck. */
export function failingGates(f: Features, g = config.gates): string[] {
  const out: string[] = [];
  for (const gate of GATES) if (!gate.temporal && gate.test(f, g)) out.push(gate.key);
  return out;
}
