"""
Signal analysis report: reads the bot's data files and writes a PDF.

  python scripts/report/make_pdf.py [--data data] [--outage reports/outage.json] [--out reports/signal-analysis.pdf]

Usually run through scripts/report/run.sh, which downloads fresh data from Railway
and builds outage.json first.
"""
import argparse, json, glob, statistics as st, collections, datetime as dt, tempfile
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, KeepTogether

ap = argparse.ArgumentParser(description='Build the signal analysis PDF.')
ap.add_argument('--data', default='data', help='directory holding signals.jsonl and dataset-*.jsonl')
ap.add_argument('--outage', default='reports/outage.json', help='output of outages.py')
ap.add_argument('--out', default='reports/signal-analysis.pdf')
args = ap.parse_args()
DATA, OUT = args.data, args.out
SCR = tempfile.mkdtemp(prefix='signal-report-')  # chart images
R = [json.loads(l) for l in open(f'{DATA}/signals.jsonl') if l.strip()]
rows = [json.loads(l) for fn in sorted(glob.glob(f'{DATA}/dataset-*.jsonl')) for l in open(fn) if l.strip()]
ret = lambda r: r['perf']['sim']['returnPct']
utc = lambda t: dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).strftime('%b %d %H:%M')

def stats(rs):
    ex = collections.Counter(r['perf']['sim']['exitReason'] for r in rs); n = len(rs)
    pk = [r['perf']['peakMult'] for r in rs]
    return dict(n=n, tp=100 * ex['tp'] / n, sl=100 * ex['sl'] / n, time=100 * ex['time'] / n,
                avg=st.mean(map(ret, rs)), med=st.median(map(ret, rs)), x2=100 * sum(p >= 2 for p in pk) / n)

ALL = stats(R)
tiers = {t: stats([r for r in R if r['tier'] == t]) for t in 'ABC'}
buckets = [(lo, [r for r in R if lo <= r['score'] < lo + 5]) for lo in range(50, 90, 5)]
mc = sorted(r['entryMcapUsd'] for r in R); qs = [mc[len(mc) * i // 4] for i in range(1, 4)]
mcq = [stats([r for r in R if a <= r['entryMcapUsd'] < b]) for a, b in zip([0] + qs, qs + [1e12])]
cps = {k: [r['perf']['checkpoints'][k] for r in R if r['perf']['checkpoints'][k]] for k in ['5m', '15m', '30m', '60m']}
peaks = [r['perf']['peakMult'] for r in R]
peak_at = [r['perf']['peakAtMin'] for r in R if r['perf']['peakMult'] > 1.05]
velmax = 100 * sum(r['parts']['velocity'] >= 25 for r in R) / len(R)
first, last = utc(min(r['signaledAt'] for r in R)), utc(max(r['signaledAt'] for r in R))
nbpm = sorted(r['features']['newBuyersPerMin'] for r in R)
low_scores = sum(50 <= r['score'] < 60 for r in R)
oc_over = [r for r in R if r['onchain'] and r['onchain']['top10Pct'] > 35]
oc_over_sl = sum(r['perf']['sim']['exitReason'] == 'sl' for r in oc_over)
# Outage figures come from Railway warn logs, summarized by outages.py.
OUTAGE = json.load(open(args.outage))

def ds(pred, age=180):
    sn = [s for r in rows for s in r['snapshots'] if s['ageSec'] == age and pred(s['features'])]
    n = len(sn); tp = sum(s['first'] == 'tp' for s in sn); sl = sum(s['first'] == 'sl' for s in sn)
    return n, 100 * tp / n, 100 * sl / n, 100 * tp / max(tp + sl, 1)

filters = [
    ('Active pool (20+ buyers, curve 5%+)', lambda f: f['uniqueBuyers'] >= 20 and f['curvePct'] >= 5, 180),
    ('Curve 35-85%', lambda f: 35 <= f['curvePct'] <= 85, 180),
    ('Curve 35-85% + inflow 20%+ of mcap', lambda f: 35 <= f['curvePct'] <= 85 and f['netFlowRelPct'] >= 20, 180),
    ('... + 11+ new buyers/min', lambda f: 35 <= f['curvePct'] <= 85 and f['netFlowRelPct'] >= 20 and f['newBuyersPerMin'] >= 11, 180),
    ('Same filter, at 5 minutes old', lambda f: 35 <= f['curvePct'] <= 85 and f['netFlowRelPct'] >= 20 and f['newBuyersPerMin'] >= 11, 300),
]
frows = [(lbl, *ds(p, a)) for lbl, p, a in filters]

# ── charts ──
INK, GREY, RED, GREEN, AMBER = '#1f2937', '#9ca3af', '#c2410c', '#15803d', '#b45309'
plt.rcParams.update({'font.family': 'Helvetica', 'font.size': 9, 'axes.spines.top': False, 'axes.spines.right': False,
                     'axes.edgecolor': GREY, 'axes.labelcolor': INK, 'xtick.color': INK, 'ytick.color': INK})

def save(fig, name):
    p = f'{SCR}/{name}.png'; fig.tight_layout(); fig.savefig(p, dpi=200); plt.close(fig); return p

fig, ax = plt.subplots(figsize=(6.5, 2.1))
labels = ['All'] + [f'Tier {t}' for t in 'ABC']; data = [ALL] + [tiers[t] for t in 'ABC']
left = [0] * 4
for key, col, name in [('tp', GREEN, 'Hit 2x'), ('time', GREY, 'Closed at 60 min'), ('sl', RED, 'Hit stop')]:
    vals = [d[key] for d in data]
    ax.barh(labels, vals, left=left, color=col, label=name, height=0.6)
    for i, v in enumerate(vals):
        if v > 7: ax.text(left[i] + v / 2, i, f'{v:.0f}%', ha='center', va='center', color='white', fontsize=8)
    left = [a + b for a, b in zip(left, vals)]
ax.invert_yaxis(); ax.set_xlim(0, 100); ax.set_xlabel('% of signals')
ax.legend(ncol=3, frameon=False, loc='upper center', bbox_to_anchor=(0.5, 1.22))
c1 = save(fig, 'c_outcomes')

fig, ax = plt.subplots(figsize=(6.5, 1.9))
xs = [f'{lo}-{lo+4}' for lo, _ in buckets]; ys = [st.mean(map(ret, b)) for _, b in buckets]
bars = ax.bar(xs, ys, color=RED, width=0.6)
for b, y, (_, rs) in zip(bars, ys, buckets):
    ax.text(b.get_x() + b.get_width() / 2, y - 1.5, f'{y:.0f}%\nn={len(rs)}', ha='center', va='top', fontsize=7.5, color=INK)
ax.axhline(0, color=INK, lw=0.8); ax.set_ylim(min(ys) - 14, 3)
ax.set_ylabel('Avg return'); ax.set_xlabel('Signal score')
c2 = save(fig, 'c_score')

fig, (a1, a2) = plt.subplots(1, 2, figsize=(6.5, 2.4))
ks = list(cps); a1.plot(ks, [st.median(cps[k]) for k in ks], marker='o', color=RED)
a1.plot(ks, [100 * sum(x >= 1 for x in cps[k]) / len(cps[k]) / 100 for k in ks], marker='o', color=GREY)
a1.axhline(1, color=INK, lw=0.6, ls='--')
a1.set_title('After the alert', fontsize=9, color=INK)
a1.text(3, st.median(cps['60m']) + 0.04, 'median multiple', color=RED, ha='right', fontsize=7.5)
a1.text(3, 0.12, 'share above entry', color='#6b7280', ha='right', fontsize=7.5)
a1.set_ylim(0, 1.15)
th = [1.2, 1.3, 1.5, 2, 3, 5]; pv = [100 * sum(p >= x for p in peaks) / len(peaks) for x in th]
a2.bar([f'{x}x' for x in th], pv, color=[AMBER] * 3 + [GREEN] * 3, width=0.6)
for i, v in enumerate(pv): a2.text(i, v + 1, f'{v:.0f}%', ha='center', fontsize=7.5)
a2.set_title('Share of signals whose peak reached...', fontsize=9, color=INK); a2.set_ylim(0, 58)
c3 = save(fig, 'c_timing')

# ── document ──
ss = getSampleStyleSheet()
H1 = ParagraphStyle('h1', parent=ss['Title'], fontName='Helvetica-Bold', fontSize=20, leading=24, alignment=0, textColor=colors.HexColor(INK), spaceAfter=4)
H2 = ParagraphStyle('h2', parent=ss['Heading2'], fontName='Helvetica-Bold', fontSize=13, leading=16, textColor=colors.HexColor(INK), spaceBefore=12, spaceAfter=5)
B = ParagraphStyle('b', parent=ss['BodyText'], fontName='Helvetica', fontSize=9.5, leading=13.5, textColor=colors.HexColor(INK), spaceAfter=5)
SM = ParagraphStyle('sm', parent=B, fontSize=8, leading=11, textColor=colors.HexColor('#6b7280'))
BL = ParagraphStyle('bl', parent=B, leftIndent=12, bulletIndent=2)
CALL = ParagraphStyle('call', parent=B, fontSize=10.5, leading=15, backColor=colors.HexColor('#fef2f2'), borderPadding=8, borderColor=colors.HexColor('#fecaca'), borderWidth=0.6, spaceBefore=6, spaceAfter=12)
P = lambda t, s=B: Paragraph(t, s)
bul = lambda t: Paragraph(t, BL, bulletText='•')

HD = ParagraphStyle('hd', fontName='Helvetica-Bold', fontSize=8.5, leading=10, alignment=2, textColor=colors.HexColor(INK))
HDL = ParagraphStyle('hdl', parent=HD, alignment=0)

def table(data, widths, num_from=1):
    data = [[Paragraph(str(c), HDL if i < num_from else HD) for i, c in enumerate(data[0])]] + data[1:]
    t = Table(data, colWidths=widths, hAlign='LEFT')
    t.setStyle(TableStyle([
        ('FONT', (0, 0), (-1, 0), 'Helvetica-Bold', 8.5), ('FONT', (0, 1), (-1, -1), 'Helvetica', 8.5),
        ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor(INK)),
        ('LINEBELOW', (0, 0), (-1, 0), 0.8, colors.HexColor(INK)),
        ('LINEBELOW', (0, 1), (-1, -1), 0.3, colors.HexColor('#e5e7eb')),
        ('ALIGN', (num_from, 0), (-1, -1), 'RIGHT'), ('VALIGN', (0, 0), (-1, -1), 'BOTTOM'),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5)]))
    return t

img = lambda p, h: Image(p, width=6.5 * inch, height=h * inch)
f1 = lambda x: f'{x:.1f}%'
s = []
s += [P('DcordBot Signal Analysis', H1),
      P(f'Forward-test results for {ALL["n"]} finished pump.fun signals, {first} to {last} UTC, plus '
        f'{len(rows):,} tracked-token snapshots. Source: the bot\'s own data files on the Railway volume. '
        f'Prepared {dt.date.today():%B %d, %Y}.', SM), Spacer(1, 6)]
s.append(P(f'<b>Bottom line:</b> the signals lose money. The average simulated trade returns <b>{ALL["avg"]:.1f}%</b> '
           f'and the median <b>{ALL["med"]:.1f}%</b>. Breaking even would need about a 29% chance of reaching 2x before '
           f'the stop; the bot is at about {ALL["x2"]:.0f}%. None of the measures the bot collects separates winners from losers '
           f'well enough to fix that by retuning thresholds.', CALL))

s.append(P('How the signals performed', H2))
s.append(P('Each signal is simulated as a trade: entry 5% worse than the alert price, take profit at 2x, stop at -35%, '
           'otherwise closed after 60 minutes, with 3% round-trip costs.'))
hdr = ['', 'Signals', 'Hit 2x', 'Hit stop', 'Closed at 60 min', 'Avg return', 'Median return']
s.append(table([hdr] + [[lbl, d['n'], f1(d['tp']), f1(d['sl']), f1(d['time']), f1(d['avg']), f1(d['med'])]
                        for lbl, d in zip(labels, data)], [0.8 * inch] + [0.95 * inch] * 6))
s += [Spacer(1, 4), img(c1, 2.1)]

s.append(KeepTogether([P('The score does not predict results', H2),
    P(f'Higher scores should mean better trades. They don\'t: no score range made money, and the best tier did worst. '
      f'Tier A averaged {tiers["A"]["avg"]:.1f}% and hit the stop on {tiers["A"]["sl"]:.0f}% of its signals.'), img(c2, 1.9)]))
s.append(bul(f'The new-buyers-per-minute component (25 of 100 points) is at its maximum in <b>{velmax:.0f}%</b> of signals. '
             f'Its target is 12 buyers a minute and the median signal shows {st.median(nbpm):.0f} (middle half: '
             f'{nbpm[len(nbpm)//4]:.0f}-{nbpm[3*len(nbpm)//4]:.0f}), so it gives almost every signal the same points.'))
s.append(bul(f'{low_scores} signals scored 50-59, below the code default minimum of 60, which suggests <font face="Courier">MIN_SCORE</font> '
             'is set lower on Railway (inferred; the variables were not read).'))

s.append(KeepTogether([P('Signals arrive after the move', H2),
    P(f'Half of all peaks come within <b>{st.median(peak_at):.1f} minutes</b> of the alert. Five minutes after the alert the median '
      f'token is at {st.median(cps["5m"]):.2f}x entry and only {100*sum(x>=1 for x in cps["5m"])/len(cps["5m"]):.0f}% are above entry; '
      f'by 60 minutes only {100*sum(x>=1 for x in cps["60m"])/len(cps["60m"]):.0f}% are. The bot is buying the end of the burst.'),
    img(c3, 2.4)]))
s.append(P(f'{pv[0]:.0f}% of signals reached 1.2x and {pv[2]:.0f}% reached 1.5x at some point, so a smaller take-profit may help. '
           'It cannot be tested yet: the bot does not save the price path, so there is no way to tell whether the peak came before the stop.'))

s.append(KeepTogether([P('The stop cannot trigger on the cheapest entries', H2),
    P(f'pump.fun prices cannot fall below the starting price, about a $2.9-3k market cap. For entries under about ${qs[0]/1000:.1f}k the -35% stop sits '
      'below that floor, so those tokens drift to the 60-minute close at roughly -30% instead of stopping out.'),
    table([['Entry market cap', 'Signals', 'Hit 2x', 'Hit stop', 'Closed at 60 min', 'Avg return']] +
          [[rng, d['n'], f1(d['tp']), f1(d['sl']), f1(d['time']), f1(d['avg'])] for rng, d in
           zip([f'Under ${qs[0]:,.0f}', f'${qs[0]:,.0f}-${qs[1]:,.0f}', f'${qs[1]:,.0f}-${qs[2]:,.0f}', f'Over ${qs[2]:,.0f}'], mcq)],
          [1.4 * inch] + [1.02 * inch] * 5)]))
s.append(Spacer(1, 4))
s.append(P(f'Higher-cap entries do relatively better (the top quarter reached 2x on {mcq[3]["x2"]:.0f}% of signals) but still lose on average.'))

s.append(KeepTogether([P('Trade-feed outages make it worse', H2),
    P(f'Trades come from the free public Solana websocket. Over this period it refused {OUTAGE["e413"]:,} connections (HTTP 413) and all three '
      f'connections were down at once {OUTAGE["down"]:,} times. The <font face="Courier">[status]</font> log line still showed '
      '<font face="Courier">ws=up</font> throughout, because that field only covers PumpPortal.'),
    P(f'Signals sent within 5 minutes of a full outage averaged <b>{OUTAGE["near_avg"]:.0f}%</b>, against <b>{OUTAGE["other_avg"]:.0f}%</b> '
      f'for the rest ({OUTAGE["near_n"]} signals, so a hint rather than proof). '
      'Missed trades leave buyer counts, inflow and holder figures incomplete.')]))

s.append(KeepTogether([P('Retuning thresholds is unlikely to fix it', H2),
    P('The snapshot dataset labels every tracked token by whether it reached 2x before -35% (no entry slippage, so these are optimistic). '
      f'Among active tokens the hit rate stays around {min(r[4] for r in frows):.0f}-{max(r[4] for r in frows):.0f}% '
      'whatever filter is applied, short of the ~29% break-even.'),
    table([['Filter (token at 3 min old unless noted)', 'Tokens', 'Hit 2x first', 'Hit -35% first', '2x share of resolved']] +
          [[l, f'{n:,}', f1(tp), f1(sl), f1(r)] for l, n, tp, sl, r in frows],
          [2.9 * inch, 0.75 * inch, 0.9 * inch, 1.0 * inch, 1.0 * inch])]))

s.append(KeepTogether([P('Settings that differ from the code defaults', H2),
    bul('Scores of 50-59 were signaled (default minimum is 60).'),
    bul(f'{len(oc_over)} signals passed with on-chain top-10 holdings above 35%, the default limit. '
        + (f'All {oc_over_sl} hit the stop.' if oc_over and oc_over_sl == len(oc_over) else f'{oc_over_sl} of them hit the stop.')),
    P('Both are inferred from the data; the Railway variables were not read.', SM)]))

s.append(KeepTogether([P('Recommended next steps', H2),
    bul('<b>Save each signal\'s price path</b> so smaller take-profits (1.3x, 1.5x) and other exits can be tested properly.'),
    bul('<b>Move the trade feed to a paid Solana provider</b> (<font face="Courier">SOLANA_WS_URL</font>) to stop the outages, and make '
        '<font face="Courier">[status]</font> report the trade connection too.'),
    bul('<b>Look for different inputs</b> rather than new limits on the current ones, e.g. entering later or buying pullbacks instead of the burst.'),
    bul('<b>Re-fit or drop the score.</b> In its current form it ranks signals no better than chance.')]))
s += [Spacer(1, 10), P('Simulated results only; real fills on thin bonding curves are usually worse. Not financial advice.', SM)]

def footer(c, d):
    c.saveState(); c.setFont('Helvetica', 7.5); c.setFillColor(colors.HexColor('#9ca3af'))
    c.drawString(inch, 0.55 * inch, 'DcordBot signal analysis'); c.drawRightString(7.5 * inch, 0.55 * inch, f'Page {d.page}'); c.restoreState()

SimpleDocTemplate(OUT, pagesize=letter, leftMargin=inch, rightMargin=inch, topMargin=0.8 * inch, bottomMargin=0.8 * inch,
                  title='DcordBot Signal Analysis', author='DcordBot').build(s, onFirstPage=footer, onLaterPages=footer)
print('wrote', OUT)
