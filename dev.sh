#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Load env vars (prefer .env.local for local dev)
set -a
[[ -f .env.local ]] && source .env.local || [[ -f .env ]] && source .env
set +a

# Find an available port, incrementing from PORT (default 3000)
BASE_PORT="${PORT:-3000}"
PORT="$BASE_PORT"
while lsof -iTCP:"$PORT" -sTCP:LISTEN -t &>/dev/null; do
  ((PORT++))
done
if [[ "$PORT" -ne "$BASE_PORT" ]]; then
  echo "Port $BASE_PORT in use, using $PORT"
fi
export PORT

trap "docker compose -f docker-compose.local.yml down" EXIT

docker compose -f docker-compose.local.yml up --build --attach app
