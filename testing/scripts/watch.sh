#!/bin/sh
# The final runs' watchdog: exits with one line, which wakes whoever watches, on
# an alert or after 30 min (a STATUS line). Run it in the background and re-arm
# it after every wake; never leave a long run unwatched.
#
#   sh testing/scripts/watch.sh r16
#
# ALERT FAILED: a step failed (tests, gate, merge). ALERT slow: a step past 1.5x
# its usual time. ALERT silent: no log written for 15 min, 35 in 12M steps (a hang). ALERT many:
# a thousand collections took over 7 min (E with deltas: 4.3-4.4). ALERT index:
# runs over 150 or listed packs over 400 for 3+ min (a merge stall). Check each
# with the step's log and scripts/index-state.sh before stopping anything.
gen=$1
[ -n "$gen" ] || { echo "usage: watch.sh r<N>"; exit 2; }
n=${gen#r}
B=$HOME/underlay-bench
L=$B/final$n.log
expect() { case "$1" in tests) echo 10;; gate) echo 20;; quick-*) echo 20;; many-20k*) echo 140;; 5m-*) echo 120;;
  12m-f+deltas) echo 360;; 5m-today-reads*) echo 90;; 12m-today-reads) echo 90;; *) echo 30;; esac; }
start=$(date +%s)
while :; do
  now=$(date +%s)
  if grep -q "FAILED" $L; then echo "ALERT $(grep FAILED $L | tail -1)"; exit 0; fi
  if grep -q "all done" $L; then echo "DONE all steps"; exit 0; fi
  last=$(grep " started " $L | tail -1); name=$(echo "$last" | sed 's/^=== //; s/ started .*//')
  t0=$(date -j -f "%a %b %d %T %Z %Y" "$(echo "$last" | sed 's/.* started //')" +%s 2>/dev/null || echo $now)
  mins=$(( (now - t0) / 60 )); exp=$(expect "$name")
  newest=$(ls -t $B/*.log | head -1); idle=$(( (now - $(stat -f %m "$newest")) / 60 ))
  running=1; tail -1 $L | grep -q " ended\| merged" && running=0
  if [ $running = 1 ] && [ $mins -gt $(( exp * 3 / 2 )) ]; then echo "ALERT slow: $name $mins min (expected ~$exp)"; exit 0; fi
  # A 12M export writes nothing for ~25 min (1,450 s in round 9's run).
  quiet=15; case "$name" in 12m*) quiet=35;; esac
  # A mirror logs nothing until its whole backfill is copied (5M: over an hour): while
  # files keep landing in the run's mirror folder, it isn't silent.
  if grep "^=== " $B/f$n-$name.log 2>/dev/null | tail -1 | grep -q ": mirror "; then
    M=$(ls -td $B/runs/*/mirror 2>/dev/null | head -1)
    [ -n "$M" ] && [ -n "$(find "$M" -type f -mmin -$quiet 2>/dev/null | head -1)" ] && idle=0
  fi
  if [ $idle -ge $quiet ]; then echo "ALERT silent: $(basename $newest) idle $idle min ($name, $mins min in)"; exit 0; fi
  burst=
  case "$name" in many-20k*)
    # After loading, 2,000 commits land at once for ~6 min: the index spikes (~500 runs, ~1,000 packs).
    grep -q "many: load done" $B/f$n-$name.log 2>/dev/null && burst=1
    lt=$(grep "many: loaded" $B/f$n-$name.log 2>/dev/null | tail -1 | sed 's/^\[\([0-9.]*\)s\].*/\1/')
    # A thousand collections take ~3 min in today's layout, 4.3-4.4 in E with deltas: over 7 is a slowdown.
    if [ -n "$lt" ]; then
      age=$(( (now - $(stat -f %m $B/f$n-$name.log)) ))
      lastk=$(grep -c "many: loaded" $B/f$n-$name.log)
      # The latest thousand's minutes, not the average: a slowdown shows at once.
      per=$(grep "many: loaded" $B/f$n-$name.log | tail -2 | sed 's/^\[\([0-9.]*\)s\].*/\1/' | awk 'NR==1{a=$1} NR==2{b=$1} END{if (b) printf "%d", (b-a)/60; else printf "0"}')
      if [ "$per" -gt 7 ]; then echo "ALERT many: ${per} min per 1000 collections ($lastk thousand loaded)"; exit 0; fi
    fi;;
  esac
  # The index's runs (bound 10, more while split merges wait): many means merges stalled (round 12: 902).
  R=$(ls -td $B/runs/* 2>/dev/null | head -1)
  if [ -z "$burst" ] && [ -n "$R" ] && [ -f "$R/db.sqlite" ]; then
    nr=$(python3 -c "
import sqlite3,json
c=sqlite3.connect('file:$R/db.sqlite?mode=ro',uri=True,timeout=10)
try: print(len(set(json.loads(i).get('run') or json.loads(i)['id'] for (i,) in c.execute('select info from layout_layers'))), c.execute('select count(*) from layout_packs').fetchone()[0])
except Exception: print(0, 0)" 2>/dev/null || echo 0 0)
    np=${nr#* }; nr=${nr% *}
    # Listed packs (round 14: ~30 a minute more, tier 1 never merging); bursts spike both.
    # A long merge spikes both for a minute or two (round 15: 262 runs, then 61): alert if still over 3 min later.
    if [ "$nr" -gt 150 ] || [ "$np" -gt 400 ]; then
      if [ -n "$over" ]; then echo "ALERT index: $nr runs, $np listed packs in $(basename $R) ($name, $mins min in; over since $over)"; exit 0; fi
      over=$(date +%H:%M); sleep 180; continue
    fi
    over=""
  fi
  if [ $(( now - start )) -ge 1800 ]; then echo "STATUS $name $mins min in (expected ~$exp); $(basename $newest) written ${idle} min ago"; exit 0; fi
  sleep 300
done
