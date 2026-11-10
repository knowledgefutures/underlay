#!/bin/sh
# Check a checkout's code before measuring it: the smoke suite (20k records, no
# latency) on every variant into a scratch folder, failing on any failed job or
# error, and on any version hash that differs from today's layout for the same
# run. Exits 0 when the code is fit to measure.
#
#   testing/scripts/gate.sh && testing/scripts/round.sh r4
cd "$(dirname "$0")/.." || exit 1
export UL_BENCH_DIR=${GATE_DIR:-/tmp/underlay-bench-gate-$$}
rm -rf "$UL_BENCH_DIR"
out="$UL_BENCH_DIR.log"
ok=0
# The layouts still in the running (2026-10-19): today's and F with deltas. GATE_ALL=1 runs every variant.
variants='"--layout today" "--layout f --nodes delta"'
[ -n "$GATE_ALL" ] && variants='"--layout today" "--layout today --nodes delta" "--layout a" "--layout c" "--layout d" "--layout e" "--layout e --nodes delta" "--layout f --nodes delta"'
eval "set -- $variants"
for f in "$@"; do
  # shellcheck disable=SC2086
  node --expose-gc --import tsx bench.ts suite smoke --latency none --only load,daily,reads,fork,mirror $f > "$out" 2>&1 || ok=1
  # An error's message, not a word ending in "rror:" (a mirror folder's path, for one).
  if grep -qE "failed \(attempt|(^|[^A-Za-z])[Ee]rror:|[a-z]Error:" "$out"; then
    ok=1
    echo "gate: failures with $f"
    grep -E "failed \(attempt|(^|[^A-Za-z])[Ee]rror:|[a-z]Error:" "$out" | head -5
  fi
done
node -e "
const fs=require('fs');const d=process.env.UL_BENCH_DIR+'/results';
const rs=fs.readdirSync(d).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(d+'/'+f)));
const key=r=>r.scenario+'/'+r.label.replace(/ ·.*/,'');let bad=0;
for(const r of rs){if(!r.versions||!Object.keys(r.versions).length)continue;
  const t=rs.find(x=>x.layout==='today'&&key(x)===key(r));if(!t||t===r)continue;
  for(const [k,v] of Object.entries(r.versions))if(t.versions[k]!==v){bad++;console.log('gate: hash differs',r.layout,key(r),k)}}
process.exit(bad?1:0)" || ok=1
rm -rf "$UL_BENCH_DIR" "$out"
[ $ok = 0 ] && echo "gate: passed" || echo "gate: FAILED"
exit $ok
