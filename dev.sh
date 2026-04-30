#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

MODE="${1:-dev}"

case "$MODE" in
    dev)
        COMPOSE_FILE=docker-compose.local.yml

        # Only create .env.local if it doesn't exist yet
        if [[ ! -f .env.local ]]; then
            if [[ -f .env.test ]]; then
                echo "Creating .env.local from .env.test defaults (with Docker hostnames)"
                sed -e 's|@localhost:5432|@postgres:5432|' \
                    -e 's|http://localhost:9000|http://minio:9000|' \
                    -e '/^APP_URL=/d' \
                    -e '/^API_PORT=/d' \
                    .env.test > .env.local
            else
                echo "No .env.test found — create .env.local manually"
                exit 1
            fi
            echo "Edit .env.local to customize."
        fi

        echo "Starting local development environment (source mounted, fast reload)..."
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
