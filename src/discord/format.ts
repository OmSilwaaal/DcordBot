import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import type { SignalRecord } from '../types.js';
import type { Summary } from '../signals/performance.js';

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
        name: 'Plan',
        value: `SL −${pl.stopLossPct}% · TP ${pl.takeProfitMult}× · Time ${pl.timeStopMin}m · Slip ${pl.entrySlippagePct}% · Costs ${pl.roundTripCostPct}%`,
      },
    );
}
