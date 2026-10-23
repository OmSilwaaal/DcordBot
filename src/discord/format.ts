import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import type { SignalRecord } from '../types.js';
import { GATE_BY_KEY } from '../analysis/gates.js';
import type { DiagReport } from '../signals/diagnostics.js';
import type { SignalEngine } from '../signals/engine.js';
import { newPerfState, type Summary } from '../signals/performance.js';

const COLORS = { A: 0x22c55e, B: 0xeab308, C: 0x3b82f6 } as const;
const TIER_EMOJI = { A: '🟢', B: '🟡', C: '🔵' } as const;

export const usd = (x: number | null | undefined): string => {
  if (x === null || x === undefined || !Number.isFinite(x)) return '?';
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(1)}k`;
  return `$${x.toFixed(0)}`;
};
const p0 = (x: number) => `${x.toFixed(0)}%`;
const p1 = (x: number) => `${x.toFixed(1)}%`;
const mult = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${x.toFixed(2)}×`);
const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;
const age = (sec: number) => (sec < 60 ? `${Math.round(sec)}s` : `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`);
/** Token names/symbols are attacker-controlled: strip markdown and mentions. */
export const clean = (s: string, max = 40) => s.replace(/[`*_~|>@#[\]()\\]/g, '').slice(0, max) || '?';

export function signalEmbed(r: SignalRecord): EmbedBuilder {
  const f = r.features;
  const plan = config.plan;
  const slMcap = r.entryMcapUsd * (1 - plan.stopLossPct / 100);
  const tpMcap = r.entryMcapUsd * plan.takeProfitMult;

  const oc = r.onchain;
  const checks = oc
    ? `Mint ${oc.mintAuthority ? '❌' : '✅'} · Freeze ${oc.freezeAuthority ? '❌' : '✅'} · Ext ${oc.dangerousExtensions.length ? '❌' : '✅'}\n` +
      `On-chain top10 ${p1(oc.top10Pct)} · max ${p1(oc.maxHolderPct)}`
    : '⚠️ On-chain check unavailable';
  const rc =
    r.rugcheck.status === 'ok'
      ? `RugCheck ✅${r.rugcheck.warnings.length ? ` (${r.rugcheck.warnings.length} warn)` : ''}`
      : `RugCheck: ${r.rugcheck.status}`;

  const soc = r.socials;
  const socials =
    [soc?.twitter && `[X](${soc.twitter})`, soc?.telegram && `[TG](${soc.telegram})`, soc?.website && `[Web](${soc.website})`]
      .filter(Boolean)
      .join(' · ') || 'none';

  const pt = r.parts;
  const e = new EmbedBuilder()
    .setColor(COLORS[r.tier])
    .setTitle(`${TIER_EMOJI[r.tier]} Tier ${r.tier} · $${clean(r.symbol, 20)} — ${clean(r.name)}`)
    .setURL(`https://pump.fun/coin/${r.mint}`)
    .setDescription(
      `**Score ${r.score}/100** · MCap **${usd(r.entryMcapUsd)}** · Curve **${p0(f.curvePct)}** · Age **${age(f.ageSec)}**`,
    )
    .addFields(
      {
        name: '📈 Flow (5m)',
        value:
          `Buyers ${f.buyers5m} (${f.uniqueBuyers} total) · New/min ${f.newBuyersPerMin.toFixed(1)}\n` +
          `Buys ${p0(f.buyCountPct5m)} (SOL ${p0(f.buySolPct5m)}) · Net ${signed(f.netFlowSol5m)} SOL`,
        inline: true,
      },
      {
        name: '👥 Holders',
        value: `Top10 ${p1(f.top10Pct)} · Max ${p1(f.maxHolderPct)}\nDev ${p1(f.devPct)} · Snipers ${p1(f.sniperPct)}`,
        inline: true,
      },
      {
        name: '🧪 Organic',
        value: `Top3 vol ${p0(f.volConcTop3Pct)} · Churn ${p0(f.washPct)}\nMedian buy ${f.medianBuySol5m.toFixed(2)} SOL`,
        inline: true,
      },
      { name: '🛡️ Checks', value: `${checks}\n${rc}`, inline: true },
      { name: '🔗 Socials', value: socials, inline: true },
      { name: '👤 Creator', value: creatorLine(f), inline: true },
      { name: '🕵️ Wallets', value: walletLine(r), inline: true },
      { name: '🧬 Wallet intel', value: walletIntelLine(f), inline: true },
      { name: '📣 Attention', value: attentionLine(r), inline: true },
      {
        name: '🧮 Score breakdown',
        value: `Vel ${pt.velocity} · Flow ${pt.flow} · Press ${pt.pressure}\nDist ${pt.distribution} · Org ${pt.organic} · Soc ${pt.socials} · Tick ${pt.ticker}`,
        inline: true,
      },
      {
        name: '🎯 Plan (forward-tested)',
        value: `SL −${plan.stopLossPct}% (${usd(slMcap)}) · TP ${plan.takeProfitMult}× (${usd(tpMcap)}) · Time stop ${plan.timeStopMin}m`,
      },
      { name: 'CA', value: `\`${r.mint}\`` },
      {
        name: 'Links',
        value: `[DexScreener](https://dexscreener.com/solana/${r.mint}) · [pump.fun](https://pump.fun/coin/${r.mint}) · [Solscan](https://solscan.io/token/${r.mint})`,
      },
    )
    .setFooter({ text: `Not financial advice · ${r.id}` })
    .setTimestamp(r.signaledAt);

  if (r.finalizedAt) e.addFields({ name: '🏁 Result', value: resultLine(r) });
  return e;
}

function creatorLine(f: SignalRecord['features']): string {
  if (f.creatorPriorLaunches === 0) return 'First launch seen from this wallet';
  const last = f.creatorMinSinceLast < 0 ? '' : ` · last ${f.creatorMinSinceLast < 120 ? `${f.creatorMinSinceLast.toFixed(0)}m` : `${(f.creatorMinSinceLast / 60).toFixed(0)}h`} ago`;
  return `${f.creatorPriorLaunches} prior (${f.creatorLaunches24h} in 24h) · ${f.creatorPriorGraduated} graduated${last}`;
}

function walletLine(r: SignalRecord): string {
  const w = r.wallets;
  if (!w) return 'not analyzed';
  return (
    `Fresh ${p0(w.freshPct)} · low-activity ${p0(w.lowActivityPct)} (n=${w.sampled})\n` +
    `Clusters ${w.clusters}${w.clusters ? ` (max ${w.largestCluster}) hold ${p1(w.clusterHoldPct)}` : ''} · dev-funded ${w.devFundedBuyers}`
  );
}

function walletIntelLine(f: SignalRecord['features']): string {
  // Records from before wallet intel existed don't have these fields.
  if (f.knownBuyerPct === undefined) return 'not recorded';
  const launch =
    f.launchBlockHoldPct < 0
      ? 'Launch block: unknown'
      : `Launch block ${f.launchBlockBuyers} wallets, hold ${p1(f.launchBlockHoldPct)}`;
  return (
    `${launch} · same-block groups ${p1(f.slotClusterHoldPct)}\n` +
    `First buyers sold ${p0(f.earlyBuyersSoldPct)} · known ${p0(f.knownBuyerPct)} of buyers\n` +
    `Flippers ${p1(f.flipperHoldPct)} · serial snipers ${p1(f.serialSniperHoldPct)} · profitable wallets ${f.profitableBuyers}\n` +
    `Habitual losers: ${f.loserBuyers1m} buying now, hold ${p1(f.loserHoldPct)}`
  );
}

function attentionLine(r: SignalRecord): string {
  const d = r.dexOrders;
  const dex = d
    ? `DexS: profile ${d.paidProfile ? '✅' : '–'}${d.communityTakeover ? ' · CTO' : ''}${d.boosts ? ` · ${d.boosts} boosts` : ''}${d.ads ? ` · ${d.ads} ads` : ''}`
    : 'DexS: –';
  const x = r.x;
  const xl = x
    ? `X: ${x.posts}${x.capped ? '+' : ''} posts · ${x.authors} authors · med ${Math.round(x.medianFollowers)} followers`
    : `X: ${config.x.mode === 'off' ? 'off' : 'no data'}`;
  return `${dex}\n${xl}`;
}

export function resultLine(r: SignalRecord): string {
  const p = r.perf;
  const c = p.checkpoints;
  const sim = p.sim;
  const outcome =
    sim.exitReason === 'tp' ? 'TP hit' : sim.exitReason === 'sl' ? 'Stopped out' : sim.exitReason === 'time' ? 'Time stop' : 'open';
  return (
    `Peak **${mult(p.peakMult)}** @ ${p.peakAtMin.toFixed(0)}m · Low ${mult(p.troughMult)}${p.graduated ? ' · 🎓 graduated' : ''}\n` +
    `5m ${mult(c['5m'])} · 15m ${mult(c['15m'])} · 30m ${mult(c['30m'])} · 60m ${mult(c['60m'])}\n` +
    `Plan: ${outcome} → **${sim.returnPct === null ? '–' : signed(sim.returnPct) + '%'}**`
  );
}

export function statsEmbed(s: Summary, hours: number): EmbedBuilder {
  const tiers =
    Object.entries(s.byTier)
      .map(([t, v]) => `Tier ${t}: n=${v.n} · TP ${p0(v.tpRate)} · avg ${signed(v.avgReturnPct)}%`)
      .join('\n') || '–';
  return new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle(`📊 Signal performance — last ${hours}h`)
    .setDescription(
      s.n === 0
        ? `No finished signals yet (${s.active} still being forward-tested).`
        : `**${s.n}** finished · ${s.active} active\n` +
            `Plan outcome: TP ${p0(s.tpRate)} · SL ${p0(s.slRate)} · Time ${p0(s.timeRate)}\n` +
            `Avg return **${signed(s.avgReturnPct)}%** · Median ${signed(s.medianReturnPct)}%\n` +
            `Median peak ${mult(s.medianPeak)} · Peaked ≥2× ${p0(s.pct2x)} · ≥3× ${p0(s.pct3x)}`,
    )
    .addFields({ name: 'By tier', value: tiers })
    .setFooter({ text: 'Returns include entry slippage + round-trip costs. Peaks are not realizable returns.' });
}

export function filtersEmbed(): EmbedBuilder {
  const g = config.gates;
  const pl = config.plan;
  return new EmbedBuilder()
    .setColor(0x64748b)
    .setTitle('⚙️ Active filters')
    .addFields(
      {
        name: 'Flow',
        value: `Age ≥ ${g.minAgeSec}s · Curve ${g.minCurvePct}–${g.maxCurvePct}%\nBuyers ≥ ${g.minUniqueBuyers} (5m ≥ ${g.minBuyers5m}) · Buy share ≥ ${g.minBuyCountPct5m}% · Net ≥ ${g.minNetFlowSol5m} SOL`,
      },
      {
        name: 'Supply',
        value: `Top10 ≤ ${g.maxTop10Pct}% (chain ≤ ${g.onchainMaxTop10Pct}%) · Max holder ≤ ${g.maxSingleHolderPct}% (chain ≤ ${g.onchainMaxSingleHolderPct}%)\nDev ≤ ${g.maxDevPct}%, sold ≤ ${g.maxDevSellPct}% · Snipers ≤ ${g.maxSniperPct}%`,
      },
      {
        name: 'Quality',
        value: `Top3 vol ≤ ${g.maxVolConcTop3Pct}% · Churn ≤ ${g.maxWashPct}% · Off peak ≤ ${g.maxDrawdownPct}% · Ticker dupes ≤ ${g.maxTickerDupes}\nScore ≥ ${config.scoring.minScore}`,
      },
      {
        name: 'Wallets (verify)',
        value:
          `Fresh ≤ ${g.maxFreshWalletPct}% · cluster-held ≤ ${g.maxClusterHoldPct}% · dev-funded buyers ≤ ${g.maxDevFundedBuyers}` +
          ` · creator launches/24h ≤ ${g.maxCreatorLaunches24h}\n_Values of 100 / 1000 mean log-only (gate off)._`,
      },
      {
        name: 'Wallet intel (stream)',
        value:
          `Launch-block hold ≤ ${g.maxLaunchBlockHoldPct}% · same-block groups ≤ ${g.maxSlotClusterHoldPct}% · first buyers sold ≤ ${g.maxEarlyBuyersSoldPct}%\n` +
          `Flippers ≤ ${g.maxFlipperHoldPct}% · serial snipers ≤ ${g.maxSerialSniperHoldPct}% · profitable-wallet buyers ≤ ${g.maxProfitableBuyers}` +
          ` · losers buying (1m) ≤ ${g.maxLoserBuyers1m}\n_100 / 1000 mean log-only (gate off)._`,
      },
      {
        name: 'Plan',
        value: `SL −${pl.stopLossPct}% · TP ${pl.takeProfitMult}× · Time ${pl.timeStopMin}m · Slip ${pl.entrySlippagePct}% · Costs ${pl.roundTripCostPct}%`,
      },
    );
}

// ── /status and /test ────────────────────────────────────────────────

const ICON = (ok: boolean | null) => (ok === true ? '✅' : ok === false ? '❌' : '⚠️');

export function statusEmbed(r: DiagReport): EmbedBuilder {
  const broken = r.checks.filter((c) => c.ok === false).length;
  const warn = r.checks.filter((c) => c.ok === null).length;
  const s = r.stats;
  const cands =
    r.candidates
      .map((c) => `**$${clean(c.symbol, 14)}** · score ${c.score} · curve ${p0(c.f.curvePct)} · ${usd(c.f.mcapUsd)} — _${clean(c.reason, 60)}_`)
      .join('\n') || 'none yet — the bot needs a minute or two of launches';
  return new EmbedBuilder()
    .setColor(broken ? 0xef4444 : warn ? 0xeab308 : 0x22c55e)
    .setTitle(broken ? `🩺 Radar status — ${broken} problem(s)` : warn ? '🩺 Radar status — running, with warnings' : '🩺 Radar status — all systems go')
    .setDescription(r.checks.map((c) => `${ICON(c.ok)} **${c.name}** — ${c.detail}`).join('\n'))
    .addFields(
      {
        name: `Pipeline (up ${r.uptimeMin.toFixed(0)}m)`,
        value:
          `Launches ${s.created} · trades ${s.trades} · evaluations ${s.evaluated}\n` +
          `Verified ${s.verified} · rejected ${s.rejected} · **signals ${s.signals}** · forward-testing ${r.forwardTesting}`,
      },
      { name: 'Closest to signaling right now', value: cands.slice(0, 1024) },
    )
    .setFooter({ text: 'No signals yet is normal — the gates are strict. Candidates above show the filters are working.' })
    .setTimestamp(Date.now());
}

/** Clearly-labelled fake signal: verifies channel permissions and embed rendering without touching real data. */
export function testSignalEmbed(): EmbedBuilder {
  const now = Date.now();
  const fake: SignalRecord = {
    id: `TEST-${now}`,
    mint: 'TEST-NOT-A-REAL-TOKEN',
    symbol: 'TEST',
    name: 'Test signal — ignore',
    signaledAt: now,
    score: 77,
    tier: 'B',
    parts: { velocity: 20, flow: 15, pressure: 11, distribution: 15, organic: 8, socials: 3, ticker: 5 },
    features: {
      ageSec: 134, mcapSol: 160, mcapUsd: 28_800, curvePct: 34, uniqueBuyers: 61, holders: 55, buyers5m: 44,
      newBuyersPerMin: 14.2, buyerAccel: 3, buys5m: 70, sells5m: 31, buyCountPct5m: 69, buySolPct5m: 72,
      volSol5m: 48, netFlowSol5m: 21, netFlowRelPct: 13, medianBuySol5m: 0.31, top10Pct: 19.5, maxHolderPct: 4.2,
      devPct: 2.1, devSoldPct: 0, sniperPct: 5.5, volConcTop3Pct: 24, washPct: 4, drawdownPct: 8, tickerDupes: 0,
      repeatSizePct5m: 6, creatorPriorLaunches: 2, creatorLaunches24h: 1, creatorPriorGraduated: 0,
      creatorBestPriorPeakSol: 95, creatorMinSinceLast: 340, launchesPerMin: 14, graduations1h: 9, solChange1hPct: 0.4,
      launchBlockBuyers: 2, launchBlockHoldPct: 3.1, earlyBlocksHoldPct: 6.4, slotClusterHoldPct: 4.2,
      earlyBuyersSoldPct: 38, knownBuyerPct: 64, profitableBuyers: 3, profitableHoldPct: 2.7, flipperHoldPct: 5.9,
      serialSniperHoldPct: 2.2, loserHoldPct: 1.4, loserBuyers1m: 2,
    },
    wallets: { ok: true, sampled: 20, freshPct: 15, lowActivityPct: 20, clusters: 1, largestCluster: 2, clusterWallets: 2, clusterHoldPct: 1.8, devFundedBuyers: 0 },
    dexOrders: { ok: true, paidProfile: true, communityTakeover: false, ads: 0, boosts: 0, minToFirstPaid: 4 },
    x: { ok: true, posts: 3, capped: false, authors: 3, medianFollowers: 210, newAccountPct: 33 },
    onchain: { ok: true, mintAuthority: null, freezeAuthority: null, dangerousExtensions: [], top10Pct: 21.3, maxHolderPct: 4.4 },
    rugcheck: { status: 'ok', dangers: [], warnings: [] },
    socials: null,
    entryMcapUsd: 28_800,
    solPriceAtSignal: 180,
    perf: newPerfState(),
  };
  const e = signalEmbed(fake);
  return e
    .setTitle('🧪 TEST SIGNAL — not a real token, do not buy')
    .setURL(null)
    .setColor(0x9ca3af)
    .setFooter({ text: 'Posted by /test to verify the bot can post here. Real signals look like this.' });
}

export function funnelEmbed(r: ReturnType<SignalEngine['funnelReport']>): EmbedBuilder {
  const g = config.gates;
  const label = (k: string) => GATE_BY_KEY.get(k)?.label(g) ?? k;
  const lines = (rows: [string, number][], fmt: (k: string) => string, n = 8) =>
    rows.slice(0, n).map(([k, v]) => `\`${String(v).padStart(4)}\` ${fmt(k)}`).join('\n') || '–';
  const pctOf = (a: number, b: number) => (b ? ` (${((a / b) * 100).toFixed(1)}%)` : '');

  return new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle(`🔎 Signal funnel — last ${r.sinceMin < 120 ? `${r.sinceMin.toFixed(0)}m` : `${(r.sinceMin / 60).toFixed(1)}h`}`)
    .setDescription(
      `Launches seen **${r.launches}** → reached ${g.minAgeSec}s **${r.matured}** → passed every gate **${r.passedGates}**${pctOf(r.passedGates, r.matured)}\n` +
        `→ blocked by score **${r.scoreBlocked}** → sent to verify **${r.verified}** → **signals ${r.signals}**`,
    )
    .addFields(
      {
        name: '🚧 Near misses — tokens stopped by exactly ONE gate',
        value: lines(r.nearMiss, label) + '\n_The top line is the gate costing you the most signals._',
      },
      { name: '🛡️ Verify stage outcomes', value: lines(r.verifyOutcomes, (k) => k) },
      { name: '⛔ Permanent rejections', value: lines(r.permanentRejects, (k) => k, 6) },
    )
    .setFooter({ text: 'Counts reset on redeploy. Loosen one gate at a time via Railway variables, then compare.' });
}
