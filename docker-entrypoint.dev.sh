#!/bin/sh
set -e

# Auto-install deps if package-lock.json changed since last install
LOCK_HASH=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1)
STORED_HASH=""
[ -f node_modules/.lock-hash ] && STORED_HASH=$(cat node_modules/.lock-hash)

if [ "$LOCK_HASH" != "$STORED_HASH" ]; then
  echo "[dev-entrypoint] package-lock.json changed — running npm install..."
  npm install
  echo "$LOCK_HASH" > node_modules/.lock-hash
fi

exec "$@"
