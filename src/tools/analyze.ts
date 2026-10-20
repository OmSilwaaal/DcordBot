/**
 * Edge discovery: `npm run analyze`
 *
 * 1. Live signals — how the forward-tested plan actually performed.
 * 2. Dataset — every tracked token was snapshotted at fixed ages and labelled
 *    with what happened next (TP before SL?). For each feature we split tokens
 *    into quintiles and compare hit rates. A feature whose top or bottom
 *    quintile beats the base rate by a wide margin is a real input; one that's
 *    flat across quintiles is noise and should lose its weight or gate.
 */
import { config } from '../config.js';
import type { Snapshot } from '../state/tracker.js';
import type { Features, SignalRecord } from '../types.js';
import { dataPath, listDataFiles, readJsonl } from '../utils/files.js';
import { median } from '../utils/math.js';

interface DatasetRow {
  mint: string;
  status: string;
  snapshots: Snapshot[];
}

const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const f1 = (x: number) => x.toFixed(1);
const pad = (s: string | number, n: number) => String(s).padEnd(n);

function signalsReport(): void {
  const rows = readJsonl<SignalRecord>(dataPath('signals.jsonl'));
  console.log('\n══ Live signals (forward-tested plan) ══');
  if (!rows.length) return console.log('No finished signals yet.');
  const rets = rows.map((r) => r.perf.sim.returnPct ?? 0);
  const by = (k: string) => rows.filter((r) => r.perf.sim.exitReason === k).length;
  console.log(
    `n=${rows.length} · TP ${f1(pct(by('tp'), rows.length))}% · SL ${f1(pct(by('sl'), rows.length))}% · time ${f1(pct(by('time'), rows.length))}%`,
  );
  console.log(
    `avg return ${f1(rets.reduce((a, b) => a + b, 0) / rows.length)}% · median ${f1(median(rets))}% · median peak ${median(rows.map((r) => r.perf.peakMult)).toFixed(2)}×`,
  );
  for (const t of ['A', 'B', 'C']) {
    const rs = rows.filter((r) => r.tier === t);
    if (!rs.length) continue;
    const avg = rs.reduce((a, r) => a + (r.perf.sim.returnPct ?? 0), 0) / rs.length;
    console.log(`  tier ${t}: n=${rs.length} · avg ${f1(avg)}% · TP ${f1(pct(rs.filter((r) => r.perf.sim.exitReason === 'tp').length, rs.length))}%`);
  }
}

function datasetReport(): void {
  const rows = listDataFiles('dataset-').flatMap((f) => readJsonl<DatasetRow>(f));
  const { takeProfitMult: tp, stopLossPct: sl } = config.plan;
  console.log(`\n══ Dataset — label: ${tp}× before −${sl}% after snapshot ══`);
  if (!rows.length) return console.log('No dataset yet (needs a few hours of running).');

  for (const age of config.dataset.snapshotAgesSec) {
    const snaps = rows.flatMap((r) => r.snapshots.filter((s) => s.ageSec === age));
    if (snaps.length < 50) {
      console.log(`\n[${age}s] only ${snaps.length} samples — skipping`);
      continue;
    }
    const base = pct(snaps.filter((s) => s.first === 'tp').length, snaps.length);
    console.log(`\n[snapshot at ${age}s] n=${snaps.length} · base TP-first rate ${f1(base)}%`);
    console.log(`${pad('feature', 18)} ${['Q1 (low)', 'Q2', 'Q3', 'Q4', 'Q5 (high)'].map((q) => pad(q, 22)).join('')} lift`);

    const keys = Object.keys(snaps[0].features).filter(
      (k) => typeof (snaps[0].features as unknown as Record<string, unknown>)[k] === 'number',
    ) as (keyof Features)[];

    const results: { key: string; line: string; lift: number }[] = [];
    for (const k of keys) {
      const vals = snaps
        .map((s) => ({ v: s.features[k] as number, tp: s.first === 'tp' }))
        .filter((x) => Number.isFinite(x.v))
        .sort((a, b) => a.v - b.v);
      if (vals.length < 50 || vals[0].v === vals[vals.length - 1].v) continue; // constant → no information
      const cells: string[] = [];
      const rates: number[] = [];
      for (let q = 0; q < 5; q++) {
        const slice = vals.slice(Math.floor((q * vals.length) / 5), Math.floor(((q + 1) * vals.length) / 5));
        const rate = pct(slice.filter((x) => x.tp).length, slice.length);
        rates.push(rate);
        const lo = slice[0]?.v ?? 0;
        const hi = slice[slice.length - 1]?.v ?? 0;
        cells.push(pad(`${f1(rate)}% [${lo.toFixed(1)}–${hi.toFixed(1)}]`, 22));
      }
      const lift = base > 0 ? Math.max(...rates) / base : 0;
      results.push({ key: k, line: `${pad(k, 18)} ${cells.join('')} ${lift.toFixed(2)}×`, lift });
    }
    results.sort((a, b) => b.lift - a.lift).forEach((r) => console.log(r.line));
  }
  console.log('\nRead it like this: lift = best quintile hit rate ÷ base rate. Features near 1.0× carry no information.');
  console.log('Small samples lie — wait for several thousand tokens per snapshot age before re-tuning.');
}

/** Numeric view of everything known at signal time, including verify-stage enrichments. */
function signalVector(r: SignalRecord): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (prefix: string, obj: object | null | undefined) => {
    if (!obj) return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[prefix + k] = v;
      else if (typeof v === 'boolean' && k !== 'ok' && k !== 'capped') out[prefix + k] = v ? 1 : 0;
    }
  };
  add('', r.features);
  add('wallet.', r.wallets);
  add('dex.', r.dexOrders);
  add('x.', r.x);
  out.score = r.score;
  return out;
}

/**
 * Wallet forensics, DexScreener orders and X only exist for verified candidates,
 * so they're judged on signals: split at each feature's median, compare plan returns.
 */
function signalFeatureReport(): void {
  const rows = readJsonl<SignalRecord>(dataPath('signals.jsonl'));
  console.log('\n══ Signal features — median split, plan return above vs below ══');
  if (rows.length < 20) return console.log(`Need ≥20 finished signals (have ${rows.length}).`);
  const vecs = rows.map((r) => ({ v: signalVector(r), ret: r.perf.sim.returnPct ?? 0, tp: r.perf.sim.exitReason === 'tp' }));
  const keys = [...new Set(vecs.flatMap((x) => Object.keys(x.v)))];
  const out: { k: string; line: string; gap: number }[] = [];
  for (const k of keys) {
    const have = vecs.filter((x) => k in x.v);
    if (have.length < 20) continue;
    const med = median(have.map((x) => x.v[k]));
    const lo = have.filter((x) => x.v[k] <= med);
    const hi = have.filter((x) => x.v[k] > med);
    if (lo.length < 8 || hi.length < 8) continue; // mostly-constant feature
    const avg = (xs: typeof have) => xs.reduce((a, x) => a + x.ret, 0) / xs.length;
    const tpr = (xs: typeof have) => pct(xs.filter((x) => x.tp).length, xs.length);
    const gap = avg(hi) - avg(lo);
    out.push({
      k,
      gap,
      line: `${pad(k, 26)} ≤${pad(med.toFixed(1), 8)} n=${pad(lo.length, 4)} avg ${pad(f1(avg(lo)) + '%', 8)} TP ${pad(f1(tpr(lo)) + '%', 7)}| above: n=${pad(hi.length, 4)} avg ${pad(f1(avg(hi)) + '%', 8)} TP ${f1(tpr(hi))}%`,
    });
  }
  out.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 25).forEach((o) => console.log(o.line));
  console.log('Biggest gaps first. With small n these are hints, not conclusions — re-check every week.');
}

signalsReport();
signalFeatureReport();
datasetReport();
