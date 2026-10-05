#!/usr/bin/env bash
# Convert production's v1 data for prod, next.underlay.org (edge-redesign-build.md,
# "Deployment targets").
#
#   packages/migrate/scripts/v1-prod-to-prod.sh [OUT]      from the repo root
#   COLLECTIONS=owner/slug,… packages/migrate/scripts/v1-prod-to-prod.sh
#
# Writes repository objects to the underlay-prod bucket, and migrated.sqlite,
# report.json and migrate.log to OUT (default: a new temp directory, outside
# Dropbox: the SQLite file holds production's users and sessions). Then load it:
#
#   npx tsx packages/migrate/src/d1-data.ts $OUT/migrated.sqlite > $OUT/data.sql
#   cd packages/server && npx wrangler d1 execute underlay-prod --env prod --remote --file $OUT/data.sql
#
# Into an empty D1 with migrations applied (d1-data.ts says why), with storage
# cleanup paused (README). It reads production's Postgres for the whole run, which
# took under two hours for dev.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
OUT=${1:-$(mktemp -d -t ul-v1-prod-to-prod)}
mkdir -p "$OUT"
. packages/migrate/scripts/prod-env.sh
export TARGET_DB=file:$OUT/migrated.sqlite
echo "[v1-prod-to-prod] writing to $OUT" >&2
NODE_OPTIONS=--max-old-space-size=8192 npx tsx packages/migrate/src/main.ts \
  > "$OUT/report.json" 2> >(tee "$OUT/migrate.log" >&2)
