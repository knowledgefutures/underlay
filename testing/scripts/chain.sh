#!/bin/sh
# Run suites one after another, each to its own log, with a line in the chain's
# log as each starts and ends. Stops at the first that fails.
#
#   nohup sh testing/scripts/chain.sh r1 quick 1m > /dev/null 2>&1 &
#   sh testing/scripts/watch.sh r1          # in the background; re-arm after every wake
#
# On the box, everything runs at low priority (NICE below) and under the
# watchdog (scripts/watchdog.sh). A suite name may carry options after a colon,
# with commas for spaces: many:--collections,3000,--burst,300,--label,many-3000
cd "$(dirname "$0")/.." || exit 1
gen=$1; shift
B=${UL_BENCH_DIR:-$HOME/underlay-bench}/v3
mkdir -p "$B"
L=$B/chain-$gen.log
if [ -n "$BENCH" ]; then run="node --max-old-space-size=128 $BENCH"; else run="node --max-old-space-size=128 --import tsx v3/bench.ts"; fi
[ -n "$NICE" ] && run="$NICE $run"
echo "=== chain $gen: $* ($(date))" >> "$L"
for step in "$@"; do
  name=${step%%:*}
  opts=""; case "$step" in *:*) opts=$(echo "${step#*:}" | tr ',' ' ');; esac
  label=$(echo "$step" | tr ':,' '__' | tr -d '-')
  echo "=== $label started $(date)" >> "$L"
  # shellcheck disable=SC2086
  if $run suite $name $opts > "$B/$gen-$label.log" 2>&1; then
    echo "=== $label ended $(date)" >> "$L"
  else
    echo "=== $label FAILED $(date) (see $B/$gen-$label.log)" >> "$L"
    exit 1
  fi
done
echo "=== all done $(date)" >> "$L"
