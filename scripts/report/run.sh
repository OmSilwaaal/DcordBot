#!/usr/bin/env bash
# Pulls fresh data and logs from Railway, then builds reports/signal-analysis.pdf.
#
#   scripts/report/run.sh             # download + build
#   scripts/report/run.sh --no-fetch  # rebuild from what's already in data/ and reports/logs/
#
# Needs: the Railway CLI, logged in and linked to the DcordBot service, and an SSH key
# registered with Railway that has no passphrase (volume downloads go over SSH).
set -euo pipefail

cd "$(dirname "$0")/../.."
HERE=scripts/report
VENV=$HERE/.venv
VOLUME=${VOLUME:-dcordbot-volume}
LOGS=reports/logs
mkdir -p data reports "$LOGS"

if [ ! -x "$VENV/bin/python" ]; then
  echo "setting up $VENV"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$HERE/requirements.txt"
fi
PY="$VENV/bin/python -I"

lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }

# Railway's download can stall forever on a dropped connection; macOS has no `timeout`.
with_timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }
DOWNLOAD_TIMEOUT=${DOWNLOAD_TIMEOUT:-300}

# Railway downloads sometimes drop mid-file. Download to a temp file and only replace the
# local copy if the result ends in a whole JSON record and isn't shorter than what we had.
fetch() {
  local f=$1 tmp="data/.$1.part" have try n
  have=$(lines "data/$f")
  for try in 1 2 3 4 5; do
    rm -f "$tmp"
    with_timeout "$DOWNLOAD_TIMEOUT" railway volume files -v "$VOLUME" download "/$f" "$tmp" --overwrite >/dev/null 2>&1 || true
    n=$(lines "$tmp")
    if [ "$n" -ge "$have" ] && [ "$n" -gt 0 ] && tail -1 "$tmp" | python3 -I -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null; then
      mv "$tmp" "data/$f"
      echo "  $f: $n lines"
      return 0
    fi
    echo "  $f: incomplete download (try $try)"
    sleep 2
  done
  rm -f "$tmp"
  echo "  $f: giving up, keeping the old copy ($have lines)" >&2
}

if [ "${1:-}" != "--no-fetch" ]; then
  echo "downloading data from volume $VOLUME"
  # The bot writes one dataset file per day (UTC), so files from before yesterday are
  # final: skip them if we already have them.
  yesterday=$(date -u -v-1d +%Y-%m-%d)
  for f in $(railway volume files -v "$VOLUME" list / 2>/dev/null | tr -s ' \t' '\n\n' | grep -E '^(signals\.jsonl|dataset-.*\.jsonl)$'); do
    day=${f#dataset-}; day=${day%.jsonl}
    if [ "$day" != "$f" ] && [ -f "data/$f" ] && [[ "$day" < "$yesterday" ]]; then
      echo "  $f: final, already have it"
      continue
    fi
    fetch "$f"
  done

  # One log file per deployment that could hold signals: `railway logs` only returns the
  # deployment you name, so a restart would otherwise hide every outage before it.
  echo "fetching warn logs"
  since=$($PY -c 'import json,sys,datetime as dt; t=min(json.loads(l)["signaledAt"] for l in open("data/signals.jsonl") if l.strip()); print((dt.datetime.fromtimestamp(t/1000)-dt.timedelta(days=1)).strftime("%Y-%m-%d"))')
  rm -f "$LOGS"/warn-*.txt
  railway deployment list 2>/dev/null | awk -F' [|] ' -v since="$since" 'NF >= 3 { gsub(/^ +/, "", $1); if (substr($3, 1, 10) >= since) print $1 }' |
    while read -r dep; do
      railway logs "$dep" --lines 5000 --filter '@level:warn OR @level:error' > "$LOGS/warn-$dep.txt" 2>/dev/null || true
    done
fi

$PY "$HERE/outages.py" "$LOGS"/warn-*.txt --data data --out reports/outage.json
$PY "$HERE/make_pdf.py" --data data --outage reports/outage.json --out reports/signal-analysis.pdf
