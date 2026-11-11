#!/bin/sh
# The LighterAPI box's chain for one round. Low priority throughout; start
# scripts/watchdog.sh first.
#
#   nohup sh scripts/box-run.sh r4 > /dev/null 2>&1 &            # the short round (the default)
#   nohup sh scripts/box-run.sh r5 full > /dev/null 2>&1 &       # everything, in the plan's order
#
# full:  a 3,000-collection check, quick, 1M, a mid-size Crossref trial, 5M, 12M, 20,000
#        collections, racing, the policy over a year, and last all of Crossref with 30 daily
#        commits.
# short: the check, quick, 1M, the fork test at 12M, racing, the policy, and all of Crossref:
#        what a round needs when 5M, 12M, and 20,000 collections passed on the round before.
#
# The sized suites keep their bulk under ~/underlay-v3-bench-<round> (on /), and Crossref under
# /data/underlay-v3-core/<round>, so /data keeps room for the full load, and a new round never
# touches an earlier round's files. Nothing on the box is deleted by this script.
cd "$(dirname "$0")/.." || exit 1
export PATH=$HOME/node/bin:$PATH
export BENCH=dist/bench.mjs NICE="nice -n 10 ionice -c2 -n7"
gen=${1:-r4}
if [ "$2" = full ]; then
  UL_BENCH_DIR=$HOME/underlay-v3-bench-$gen sh scripts/chain.sh "$gen" \
    many:--collections,3000,--burst,300 quick 1m \
    crossref:--label,crossref-mid,--files,2000,--days,6,--fork-days,2 \
    5m 12m many racing policy || exit 1
else
  UL_BENCH_DIR=$HOME/underlay-v3-bench-$gen sh scripts/chain.sh "$gen" \
    many:--collections,3000,--burst,300 quick 1m \
    fork-edit:--records,12000000,--keep-days,0 racing policy || exit 1
fi
UL_BENCH_DIR=/data/underlay-v3-core/$gen sh scripts/chain.sh "$gen" crossref
