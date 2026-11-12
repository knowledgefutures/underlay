#!/bin/sh
# What the key cut saves, measured directly on the box: the Crossref sample loaded as files
# were cut before (by size) and as they are cut now (by key), each with its daily commits;
# then, on forks of each, one record taken down and everything merged back together keeping
# the files no change fell in.
#
#   nohup sh scripts/benefit.sh r7 > /dev/null 2>&1 &        # 2,000 dump files
#   sh scripts/benefit.sh r7t 20                             # a trial on 20
#
# Low priority; start scripts/watchdog.sh first. Nothing on the box is deleted.
cd "$(dirname "$0")/.." || exit 1
export PATH=$HOME/node/bin:$PATH
gen=${1:-r7}
files=${2:-2000}
export UL_BENCH_DIR=$HOME/underlay-v3-bench-$gen
B=$UL_BENCH_DIR/v3
mkdir -p "$B/bin"
cp dist/bench.mjs "$B/bin/$gen-bench.mjs"
run="nice -n 10 ionice -c2 -n7 node --max-old-space-size=96 --max-semi-space-size=8 $B/bin/$gen-bench.mjs"
L=$B/chain-$gen.log
echo "=== chain $gen: the key cut's benefit, $files dump files ($(date))" >> "$L"
step() {
  name=$1
  shift
  echo "=== $name started $(date)" >> "$L"
  # shellcheck disable=SC2086
  if $run "$@" > "$B/$gen-$name.log" 2>&1; then
    echo "=== $name ended $(date)" >> "$L"
  else
    echo "=== $name FAILED $(date) (see $B/$gen-$name.log)" >> "$L"
    exit 1
  fi
}
step load-by-size suite crossref --label crossref-by-size --files "$files" --days 6 --by-size --only load,daily
step load-by-key suite crossref --label crossref-by-key --files "$files" --days 6 --only load,daily
step benefit-by-size suite crossref-extra --label crossref-by-size --files "$files" --by-size --benefit
step benefit-by-key suite crossref-extra --label crossref-by-key --files "$files" --benefit
echo "=== all done $(date)" >> "$L"
