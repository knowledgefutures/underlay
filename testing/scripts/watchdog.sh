#!/usr/bin/env bash
# On the LighterAPI box: kill bench runs if the box runs short of memory or
# disk, so the public demo it serves keeps working. Started before any run:
#
#   nohup bash watchdog.sh > /dev/null 2>&1 &
#
# Kills when available memory is under 4 GB, or free disk on / or /data is
# under 40 GB. Logs each kill.
LOG=${UL_BENCH_DIR:-/data/underlay-v3-core}/watchdog.log
while true; do
  avail=$(awk '/MemAvailable/ {print int($2/1048576)}' /proc/meminfo)
  data=$(df --output=avail -BG /data | tail -1 | tr -dc 0-9)
  sys=$(df --output=avail -BG / | tail -1 | tr -dc 0-9)
  if [ "$avail" -lt 4 ] || [ "$data" -lt 40 ] || [ "$sys" -lt 40 ]; then
    echo "$(date -Is) watchdog: mem ${avail}G /data ${data}G / ${sys}G, killing bench runs" >> "$LOG"
    pkill -f 'scripts/chain.sh'; pkill -f 'underlay-v3-core/dist/bench.mjs'; sleep 5
    pkill -9 -f 'underlay-v3-core/dist/bench.mjs'
  fi
  sleep 10
done
