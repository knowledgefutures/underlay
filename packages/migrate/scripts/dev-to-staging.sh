#!/usr/bin/env bash
# Convert dev's v1 data for staging (edge-redesign-build.md, "Deployment targets").
#
#   packages/migrate/scripts/dev-to-staging.sh [OUT]      from the repo root
#   COLLECTIONS=owner/slug,… packages/migrate/scripts/dev-to-staging.sh
#
# Writes repository objects to the underlay-staging bucket, and migrated.sqlite,
# report.json and migrate.log to OUT (default: a new temp directory, outside
# Dropbox: the SQLite file holds dev's users and sessions). Then load it:
#
#   npx tsx packages/migrate/src/d1-data.ts $OUT/migrated.sqlite > $OUT/data.sql
#   cd packages/server && npx wrangler d1 execute underlay-staging --env staging --remote --file $OUT/data.sql
#
# Into an empty D1 with migrations applied (d1-data.ts says why). A full run took
# 3 h 19 min before each type was read once (5fb2bb1); expect well under two hours.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
OUT=${1:-$(mktemp -d -t ul-dev-to-staging)}
mkdir -p "$OUT"
. packages/migrate/scripts/staging-env.sh
export TARGET_DB=file:$OUT/migrated.sqlite
echo "[dev-to-staging] writing to $OUT" >&2
NODE_OPTIONS=--max-old-space-size=8192 npx tsx packages/migrate/src/main.ts \
  > "$OUT/report.json" 2> >(tee "$OUT/migrate.log" >&2)
