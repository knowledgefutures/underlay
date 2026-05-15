#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Load env vars (prefer .env.local for local dev)
set -a
if [[ -f .env.local ]]; then
  source .env.local
elif [[ -f .env ]]; then
  source .env
fi
set +a

# Find an available port, incrementing from PORT (default 4100)
BASE_PORT="${PORT:-4100}"
PORT="$BASE_PORT"
while lsof -iTCP:"$PORT" -sTCP:LISTEN -t &>/dev/null; do
  ((PORT++))
done
if [[ "$PORT" -ne "$BASE_PORT" ]]; then
  echo "Port $BASE_PORT in use, using $PORT"
fi
export PORT

trap "docker compose -f docker-compose.local.yml down" EXIT

docker compose --env-file .env.local -f docker-compose.local.yml up --build --attach app
