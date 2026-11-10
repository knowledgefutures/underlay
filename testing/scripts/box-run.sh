#!/bin/sh
# The LighterAPI box's full run, in the plan's order: a 3,000-collection check, quick, 1M, a
# mid-size Crossref trial, 5M, 12M, 20,000 collections, racing, the policy runs, and last all of
# Crossref with 30 daily commits. Low priority throughout; start scripts/watchdog.sh first.
#
#   nohup sh scripts/box-run.sh r1 > /dev/null 2>&1 &
#
# The sized suites keep their bulk under ~/underlay-v3-bench (on /), and Crossref under
# /data/underlay-v3-core, so /data keeps room for the full load with nothing deleted between
# suites. Nothing on the box is deleted by this script.
cd "$(dirname "$0")/.." || exit 1
export PATH=$HOME/node/bin:$PATH
export BENCH=dist/bench.mjs NICE="nice -n 10 ionice -c2 -n7"
gen=${1:-r1}
UL_BENCH_DIR=$HOME/underlay-v3-bench sh scripts/chain.sh "$gen" \
  many:--collections,3000,--burst,300 quick 1m \
  crossref:--label,crossref-mid,--files,2000,--days,6,--fork-days,2 \
  5m 12m many racing policy || exit 1
UL_BENCH_DIR=/data/underlay-v3-core sh scripts/chain.sh "$gen" crossref
