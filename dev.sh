#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Decrypt local env if needed
if [[ -f .env.local.enc ]] && [[ ! -f .env.local ]]; then
  sops -d --input-type dotenv --output-type dotenv --output .env.local .env.local.enc
fi

# Load env vars
set -a
[[ -f .env.local ]] && source .env.local
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
