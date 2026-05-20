#!/bin/bash
# Creates both the auth and app databases in a single Postgres instance.
# Mounted at /docker-entrypoint-initdb.d/ — runs once on first container start.

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE app;
    GRANT ALL PRIVILEGES ON DATABASE app TO $POSTGRES_USER;
EOSQL

echo "Created 'app' database alongside default '${POSTGRES_DB}' database."
