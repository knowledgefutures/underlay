#!/bin/sh
# Check a checkout's code before measuring it: the gate suite (20k records, no
# latency, every scenario small) into a scratch folder. Fails on an error, a
# failed step, or a result that breaks one of the design's claims (ids that
# don't match, a listed file missing, a lost upload). Exits 0 when the code is
# fit to measure.
#
#   testing/scripts/gate.sh && testing/scripts/chain.sh r1 quick 1m
#
# With BENCH set to a bundle (dist/bench.mjs), runs that instead of the source.
cd "$(dirname "$0")/.." || exit 1
export UL_BENCH_DIR=${GATE_DIR:-${TMPDIR:-/tmp}/underlay-v3-gate-$$}
rm -rf "$UL_BENCH_DIR"
out="$UL_BENCH_DIR.log"
if [ -n "$BENCH" ]; then run="node --max-old-space-size=96 --max-semi-space-size=8 $BENCH"; else run="node --max-old-space-size=96 --max-semi-space-size=8 --import tsx v3/bench.ts"; fi
ok=0
$run suite gate > "$out" 2>&1 || ok=1
if grep -qE "CHECK FAILED|FAILED checks|(^|[^A-Za-z])[Ee]rror:|[a-z]Error:" "$out"; then
  ok=1
  grep -E "CHECK FAILED|FAILED checks|(^|[^A-Za-z])[Ee]rror:|[a-z]Error:" "$out" | head -10
fi
[ $ok = 0 ] && rm -rf "$UL_BENCH_DIR" "$out"
[ $ok = 0 ] && echo "gate: passed" || echo "gate: FAILED (log: $out)"
exit $ok
