#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

MODE="${1:-dev}"

case "$MODE" in
    dev)
        COMPOSE_FILE=docker-compose.dev.yml

        # Only create .env.dev if it doesn't exist yet
        if [[ ! -f .env.dev ]]; then
            if [[ -f .env.dev.enc ]]; then
                echo "Decrypting dev secrets → .env.dev"
                sops -d --input-type dotenv --output-type dotenv .env.dev.enc > .env.dev
            else
                echo "No .env.dev found — copying .env.test defaults (with Docker hostnames)"
                sed -e 's|@localhost:5432|@postgres:5432|' \
                    -e 's|http://localhost:9000|http://minio:9000|' \
                    .env.test > .env.dev
            fi
            echo "Edit .env.dev to customize. Re-decrypt with: npm run secrets:decrypt:dev"
        fi

        echo "Starting development environment (source mounted, fast reload)..."
        ;;
    prod|build)
        COMPOSE_FILE=docker-compose.yml
        echo "Starting production-like environment (built image)..."
        echo "Make sure you've built the image first: docker build -t underlay ."
        ;;
    *)
        echo "Usage: $0 [dev|prod]"
        echo "  dev   - Fast development with source mounting (default)"
        echo "  prod  - Production-like testing with built image"
        exit 1
        ;;
esac

trap "docker compose -f $COMPOSE_FILE down --remove-orphans" EXIT

docker compose -f "$COMPOSE_FILE" up --build --attach app
