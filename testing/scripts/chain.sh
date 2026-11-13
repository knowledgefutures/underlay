#!/bin/sh
# Run suites one after another, each to its own log, with a line in the chain's
# log as each starts and ends. Stops at the first that fails.
#
#   nohup sh testing/scripts/chain.sh r1 quick 1m > /dev/null 2>&1 &
#   sh testing/scripts/watch.sh r1          # in the background; re-arm after every wake
#
# Every process runs with a heap of at most 120 MB in all (96 MB old space and three 8 MB
# semi-spaces), under the 128 MB a Worker has. --max-old-space-size=128 alone is not a cap:
# Node then allows 320 MB, and collects harder for it.
#
# On the box, everything runs at low priority (NICE below) and under the
# watchdog (scripts/watchdog.sh). A suite name may carry options after a colon,
# with commas for spaces: many:--collections,3000,--burst,300,--label,many-3000
cd "$(dirname "$0")/.." || exit 1
gen=$1; shift
B=${UL_BENCH_DIR:-$HOME/underlay-bench}/v3
mkdir -p "$B"
L=$B/chain-$gen.log
# A chain measures one build of the code: the bundle is copied aside, so a later
# build (the next round's) can't change what a running chain executes.
[ -n "$BENCH" ] || { node v3/bundle.mjs > /dev/null || exit 1; BENCH=dist/bench.mjs; }
mkdir -p "$B/bin"
cp "$BENCH" "$B/bin/$gen-bench.mjs"
run="node --max-old-space-size=96 --max-semi-space-size=8 $B/bin/$gen-bench.mjs"
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
    # With CLEAN set, a finished suite's bulk is deleted (its results are kept) to leave room
    # for the next. The Crossref store is never deleted here.
    if [ -n "$CLEAN" ]; then
      folder=$(echo "$opts" | sed -n 's/.*--label \([^ ]*\).*/\1/p'); [ -n "$folder" ] || folder=$name
      [ "$folder" = many ] && folder=many-$(echo "$opts" | sed -n 's/.*--collections \([0-9]*\).*/\1/p')
      [ "$folder" = many- ] && folder=many-20000
      case "$folder" in crossref) ;; *) rm -rf "${B:?}/$folder";; esac
    fi
  else
    echo "=== $label FAILED $(date) (see $B/$gen-$label.log)" >> "$L"
    exit 1
  fi
done
echo "=== all done $(date)" >> "$L"
