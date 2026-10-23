"""
Summarizes trade-feed outages from Railway warn/error logs into the JSON make_pdf.py reads.

  python scripts/report/outages.py LOG [LOG ...] [--data data] [--out reports/outage.json]

Each LOG is the output of `railway logs <deployment> --filter '@level:warn OR @level:error'`.
Pass one file per deployment: `railway logs` only returns the deployment you name.
"""
import argparse, bisect, datetime as dt, json, re, statistics as st, sys

ap = argparse.ArgumentParser(description='Summarize trade-feed outages for the report.')
ap.add_argument('logs', nargs='+')
ap.add_argument('--data', default='data')
ap.add_argument('--out', default='reports/outage.json')
ap.add_argument('--window-min', type=float, default=5, help='a signal this soon after a full outage counts as "near" it')
args = ap.parse_args()

# railway logs caps a fetch at 5000 lines; a full file means older outages were cut off.
LINE_CAP = 5000

down, e413 = [], 0
for fn in args.logs:
    lines = open(fn).readlines()
    if len(lines) >= LINE_CAP:
        print(f'warning: {fn} hit the {LINE_CAP}-line cap, so the earliest outages are missing', file=sys.stderr)
    for l in lines:
        if 'all sockets down' in l:
            ts = dt.datetime.strptime(l[:19], '%Y-%m-%d %H:%M:%S').replace(tzinfo=dt.timezone.utc)
            down.append(ts.timestamp() * 1000)
        if re.search(r'\[chain#\d\] socket error Unexpected server response: 413', l):
            e413 += 1
down.sort()

signals = [json.loads(l) for l in open(f'{args.data}/signals.jsonl') if l.strip()]
window = args.window_min * 60_000

def near(t):
    i = bisect.bisect_right(down, t)
    return i > 0 and t - down[i - 1] <= window

near_rets = [r['perf']['sim']['returnPct'] for r in signals if near(r['signaledAt'])]
other_rets = [r['perf']['sim']['returnPct'] for r in signals if not near(r['signaledAt'])]
out = dict(
    e413=e413,
    down=len(down),
    near_n=len(near_rets),
    near_avg=st.mean(near_rets) if near_rets else 0,
    other_avg=st.mean(other_rets) if other_rets else 0,
)
json.dump(out, open(args.out, 'w'), indent=2)
print(f'wrote {args.out}: {out}')
