#!/bin/sh
# A chain's watcher: exits with one line, which wakes whoever watches, on an
# alert or after 30 minutes (a STATUS line). Run it in the background and re-arm
# it after every wake; never leave a long run unwatched (one once degraded for
# six hours unnoticed).
#
#   sh testing/scripts/watch.sh r1 [minutes]
#
# ALERT FAILED: a step failed. ALERT silent: no log line for 15 minutes (a hang).
# ALERT check: a result broke one of the design's claims. DONE: the chain ended.
gen=$1
[ -n "$gen" ] || { echo "usage: watch.sh <chain> [minutes]"; exit 2; }
limit=$(( ${2:-30} * 60 ))
B=${UL_BENCH_DIR:-$HOME/underlay-bench}/v3
L=$B/chain-$gen.log
# GNU stat first: its -f means something else (and succeeds), so BSD's form is the fallback.
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
start=$(date +%s)
while :; do
  now=$(date +%s)
  if grep -q "FAILED" "$L" 2>/dev/null; then echo "ALERT $(grep FAILED "$L" | tail -1)"; exit 0; fi
  if grep -q "all done" "$L" 2>/dev/null; then echo "DONE $(tail -1 "$L")"; exit 0; fi
  newest=$(ls -t "$B"/$gen-*.log 2>/dev/null | head -1)
  if [ -n "$newest" ]; then
    if grep -q "CHECK FAILED" "$newest"; then echo "ALERT check: $(grep 'CHECK FAILED' "$newest" | head -1)"; exit 0; fi
    idle=$(( (now - $(mtime "$newest")) / 60 ))
    if [ "$idle" -ge "${QUIET:-15}" ]; then echo "ALERT silent: $(basename "$newest") idle $idle min; last: $(tail -1 "$newest" | cut -c1-160)"; exit 0; fi
  fi
  if [ $(( now - start )) -ge "$limit" ]; then
    echo "STATUS $(grep ' started ' "$L" | tail -1 | sed 's/^=== //'); last: $(tail -1 "${newest:-$L}" | cut -c1-200)"
    exit 0
  fi
  sleep 60
done
