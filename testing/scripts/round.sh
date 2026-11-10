#!/bin/sh
# One optimization round: the quick suite (100k records, ~6 min) on every layout
# variant, one after another, every run tagged with the round. Results land in
# $UL_BENCH_DIR/results (default ~/underlay-bench); the report's Rounds section
# compares rounds. Run it from a checkout whose code you mean to measure, and
# don't run anything else on the machine meanwhile (timings share the CPU).
#
#   caffeinate -i -s testing/scripts/round.sh r4                 # today and F with deltas
#   caffeinate -i -s testing/scripts/round.sh r4 e e+deltas      # some
#
# Variants: today today+deltas a c d e e+deltas f f+deltas. Log: ~/underlay-bench/rounds.log.
cd "$(dirname "$0")/.." || exit 1
gen=$1
[ -n "$gen" ] || { echo "usage: round.sh <round> [variants...]"; exit 2; }
shift
log=~/underlay-bench/rounds.log
mkdir -p ~/underlay-bench
# The layouts still in the running (2026-10-19); name others to run them.
[ $# -eq 0 ] && set -- today f+deltas
for v in "$@"; do
  case $v in
    today) f="--layout today" ;;
    today+deltas) f="--layout today --nodes delta" ;;
    e+deltas) f="--layout e --nodes delta" ;;
    f+deltas) f="--layout f --nodes delta" ;;
    a|c|d|e|f) f="--layout $v" ;;
    *) echo "unknown variant $v"; exit 2 ;;
  esac
  echo "=== $gen $v started $(date)" >> $log
  # $f is meant to split into separate flags.
  # shellcheck disable=SC2086
  node --expose-gc --import tsx bench.ts suite quick --gen "$gen" --keep-going $f > ~/underlay-bench/round-$gen-$v.log 2>&1
  echo "=== $gen $v ended $(date) exit $? failures: $(grep -c 'failed (attempt' ~/underlay-bench/round-$gen-$v.log)" >> $log
done
echo "=== $gen done $(date)" >> $log
