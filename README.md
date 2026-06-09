<h1><img src="public/favicon.svg" height="32" alt="" />&nbsp; Underlay</h1>

Underlay is a protocol for giving structured data a permanent address. You push JSON records and a JSON Schema. You get back a versioned, content-addressed snapshot you can point to forever.

Every piece of content — records, schemas, and files — is identified by its SHA-256 hash. Versions are manifests that reference these hashes. Storage is deduplicated globally, transfers only move data the other side doesn't have, and provenance is built in: any record can be traced back to every collection and version that includes it.

Schemas are first-class objects: inspectable, comparable, and alignable across independently authored datasets. Two collections that independently define the same Author type produce the same schema hash — alignment falls out of the data model automatically. The infrastructure doesn't need to solve interoperability. It provides enough structure that interoperability can be solved dynamically by the tools and models that consume the data.

The protocol is simple: push records in, pull records out, trust the versions. The intelligence lives in the actors, not the store. The reference implementation runs at [underlay.org](https://underlay.org).

Built by [Knowledge Futures](https://www.knowledgefutures.org), a 501(c)(3) public charity.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 24+ (LTS)
- [Docker](https://www.docker.com/) and Docker Compose

### Development

```bash
git clone https://github.com/knowledgefutures/underlay.git
cd underlay
./dev.sh
```

This starts:

- **PostgreSQL 17** on port 5433 (host) → 5432 (container)
- **Underlay** on port 4100

For team members with SOPS keys, the dev script auto-decrypts `.env.local` from `.env.local.enc`. External contributors should run `cp .env.test .env.local` first.

### Without Docker

```bash
pnpm install
cp .env.test .env.local
# Edit .env.local with your Postgres and S3 connection strings
pnpm db:migrate
pnpm db:seed
pnpm dev:app
```

### Default Seed User

The seed script creates a "Knowledge Futures" org with sample collections.
In production, user accounts are created automatically on first sign-in via [KF Auth](https://auth.knowledgefutures.org) (OIDC SSO).

## Content-Addressed Storage

Everything in Underlay is content-addressed by SHA-256:

- **Records** are stored as objects in a global `record_objects` table, keyed by the hash of their canonical JSON (`{"id":...,"type":...,"data":...}`). The same record in ten collections is stored once.
- **Schemas** are stored in a global `schemas` table, keyed by content hash. Two collections that define the same type share the same schema row.
- **Files** are stored in S3, keyed by SHA-256 of their bytes.
- **Versions** are manifests — join tables (`version_records`, `version_schemas`, `version_files`) that reference content by hash. Creating a new version that shares 99% of its records with the previous version adds only the new records to storage.

This architecture enables hash negotiation for push and pull (only transfer what the other side doesn't have), provenance (which collections contain this exact record), and forking (copy the manifest, not the data).

## CLI

The CLI wraps the same versioning logic as the server: hashing, diffing, semver derivation. Versions exist locally in a `.underlay/` directory. You can commit multiple times before pushing, inspect history offline, and push when ready.

```bash
pnpm cli init my-collection
pnpm cli schema-set schema.json
pnpm cli add records.jsonl
pnpm cli status
pnpm cli commit -m "initial load"
pnpm cli remote add origin https://underlay.org -t ul_mykey -c my-org/my-collection
pnpm cli push
```

The CLI source lives in `src/cli/`. For npm distribution, `packages/cli/` is a thin publish wrapper that uses esbuild to bundle into a standalone `@underlay/cli` package.

### Local store format

```
.underlay/
  config.json               # remotes (url, token, collection)
  HEAD                      # current version semver (e.g. v1.2.0)
  objects/ab/cd/abcd1234... # record content, keyed by hash
  schemas/ef/01/ef012345... # schema JSON, keyed by hash
  versions/v1.0.0.json      # version manifest (schemas, records, files, semver)
  staging/records.jsonl     # staged records before commit
  staging/schema.json       # staged schema before commit
```

## Architecture

| Layer        | Technology                                                    |
| ------------ | ------------------------------------------------------------- |
| Server       | Hono 4 + @hono/node-server                                    |
| Frontend     | React 19 + React Router v7 (SSR + client hydration)           |
| Styling      | Tailwind CSS 4 (@tailwindcss/vite)                            |
| Build        | Vite 6 (client + SSR bundles)                                 |
| Database     | PostgreSQL 17 + Drizzle ORM                                   |
| File Storage | S3-compatible (Cloudflare R2 in production)                   |
| Auth         | KF Auth SSO (OIDC) for web sessions + API keys (programmatic) |
| Deployment   | Docker Swarm on Hetzner, Caddy reverse proxy, Cloudflare DNS  |
| CI/CD        | GitHub Actions → GHCR → SSH → `docker stack deploy`           |
| Secrets      | SOPS + age encryption                                         |

The app runs as a single Hono server on one port (default 3000). In dev, Vite runs in middleware mode for HMR. In production, Vite builds client and SSR bundles that Hono serves directly.

## Project Structure

```
server.ts                 # Hono entry point (API routes + SSR)
vite.config.ts            # Vite config (React, Tailwind, SSR)
src/
├── entry-client.tsx      # Client hydration entry
├── entry-server.tsx      # SSR rendering (renderToPipeableStream)
├── App.tsx               # React Router routes (filesystem-based)
├── route-gen.ts          # Filesystem → route pattern conversion (wires *.data.ts loaders)
├── global.css            # Tailwind theme
├── api/                  # API route handlers
│   ├── auth.server.ts    # API auth middleware (API keys, internal tokens)
│   ├── accounts.ts       # Account/org profiles, members, avatars
│   ├── collections.ts    # Collection CRUD + export, transfer, fork
│   ├── versions.ts       # Version read APIs (manifest, records, diff) + privacy filtering
│   ├── negotiate.ts      # Push protocol: hash negotiation, record upload, commit
│   ├── records.ts        # Provenance + batch record fetch
│   ├── files.ts          # Content-addressed file storage
│   ├── schemas.ts        # Schema discovery, search, labeling
│   ├── query.ts          # SQL query tool (SQLite export + LLM SQL generation)
│   ├── ark.ts            # ARK identifier management
│   ├── ark-middleware.server.ts # ARK resolution middleware
│   ├── kf-summary.ts     # Internal summary endpoint for KF dashboards
│   ├── admin.ts          # Admin endpoints (mirror mode)
│   └── health.ts         # Health check
├── db/
│   ├── schema.ts         # Drizzle table definitions
│   ├── client.server.ts  # Database client
│   ├── migrate.ts        # Migration runner
│   ├── seed.ts           # Seed data
│   └── migrations/       # Generated SQL migrations
├── lib/
│   ├── core/             # Pure functions shared by server and CLI (each with *.test.ts)
│   │   ├── hash.ts       # hashRecord, hashSchema (SHA-256)
│   │   ├── semver.ts     # deriveSemver
│   │   ├── version-hash.ts # computeVersionHash, computePublicHash
│   │   ├── privacy.ts    # getPrivateTypes, getPrivateFields, filterRecordData
│   │   ├── validate.ts   # AJV schema validation
│   │   ├── types.ts      # Shared type definitions
│   │   └── index.ts      # Re-exports
│   ├── version-helpers.server.ts  # Re-exports core + DB-dependent helpers
│   ├── auth.ts           # better-auth config (KF Auth OIDC, API keys, orgs)
│   ├── auth.server.ts    # Session helpers
│   ├── auth-client.ts    # better-auth React client
│   ├── auth-middleware.ts # React Router requireAuth middleware
│   ├── auth-internal.server.ts # KF Auth internal API client (optional)
│   ├── mirror-config.ts  # Mirror mode config (UNDERLAY_* env vars)
│   ├── mirror-sync.ts    # Server-to-server mirroring
│   ├── sqlite-gen.ts     # Version → SQLite database generation
│   ├── s3.ts             # S3 client
│   └── ark.ts            # ARK identifier utilities
├── cli/                  # CLI source (local versioning + push/pull)
│   ├── cli.ts            # Commander entry point
│   ├── commands/         # init, schema-set, add, status, commit, log, diff, remote, push, pull
│   └── lib/              # Local store, config, staging helpers
├── routes/               # React pages (filesystem routing; sibling *.data.ts = server loaders)
│   ├── index.tsx         # Landing page
│   ├── explore.tsx       # Browse public collections
│   ├── dashboard.tsx     # User's collections
│   ├── protocol.tsx      # Protocol specification
│   ├── query.tsx         # SQL query explorer
│   ├── records/[hash].tsx # Record detail + provenance
│   ├── schemas/          # Schema browser
│   ├── settings/         # Account settings + API keys
│   ├── blog/             # Blog
│   ├── docs/             # Documentation
│   └── [owner]/          # Dynamic owner routes
│       ├── index.tsx
│       └── [collection]/
│           ├── index.tsx
│           ├── versions.tsx
│           ├── schemas.tsx
│           ├── v/[n].tsx
│           ├── diff.tsx
│           └── settings.tsx
├── components/           # Shared React components
packages/
└── cli/                  # npm publish wrapper (@underlay/cli)
    └── package.json      # esbuild bundles src/cli → dist/cli.js
public/
├── .well-known/ai.txt    # Machine-readable API docs
tools/
├── backupDb.ts           # Postgres backup → S3
├── restore.ts            # Restore database from an S3 backup
├── pruneBackups.ts       # Retention pruning of old backups
├── seedMirror.ts         # Minimal seed for mirror instances
└── cron.ts               # Scheduled task runner (backup, prune, mirror sync)
```

## Protocol and Documentation

The protocol and the platform are documented together:

| Resource      | URL                                                            | Purpose                                                             |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| Protocol spec | [/protocol](https://underlay.org/protocol)                     | Full protocol: data model, hashing, push, pull, provenance, privacy |
| User docs     | [/docs](https://underlay.org/docs)                             | Concepts, integration guide, API reference, quickstart              |
| ai.txt        | [/.well-known/ai.txt](https://underlay.org/.well-known/ai.txt) | Machine-readable API docs for LLMs and bots                         |

### Key API endpoints

All pushes use the negotiate protocol — a three-step flow similar to git's pack negotiation:

| Endpoint                                         | Purpose                                                     |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `POST .../versions/negotiate`                    | Start a push session (server returns which hashes it needs) |
| `POST .../versions/negotiate/:sessionId/records` | Send only the needed records (NDJSON)                       |
| `POST .../versions/negotiate/:sessionId/commit`  | Validate, hash, and create the immutable version            |
| `GET .../versions/:semver/manifest`              | Version manifest (add `?since=` for delta)                  |
| `GET .../versions/:semver/records`               | Paginated records                                           |
| `GET .../versions/:semver/diff?from=...`         | Diff between two versions                                   |
| `POST /api/records/batch`                        | Fetch records by hash (JSONL stream)                        |
| `GET /api/records/:hash/provenance`              | Find all collections containing a record                    |
| `POST .../fork`                                  | Fork a collection (copies manifest, not data)               |
| `GET /api/schemas`                               | Search schemas across all collections                       |

## Privacy

Privacy is part of the protocol, not just a hosted-instance feature. It operates at three levels:

- **Private types**: `"private": true` on a schema root hides all records of that type from public readers.
- **Private fields**: `"private": true` on a schema property strips that field from public responses.
- **Private records**: `"private": true` on a record when pushing hides that specific record.

The `private` flag is not part of the record hash — a record's content identity doesn't change when you change who can see it. Each version has two hashes: a **private hash** (all content, used by owners for integrity) and a **public hash** (excludes private types, fields, and records, verifiable by anyone).

Privacy filtering is implemented in `src/lib/core/privacy.ts` (pure functions) and enforced at the API layer in `src/api/versions.ts`.

## Schema System

Underlay uses **globally deduplicated, content-addressed schemas** for record validation and interoperability.

- Each record type in a collection has its own JSON Schema, stored as an immutable, content-addressed row in the global `schemas` table.
- A version declares its full set of type-to-schema bindings via the `version_schemas` join table.
- If two collections define the same fields and types for a record type, they produce the same schema hash. Alignment is automatic.
- Schemas are never modified. Evolving a type produces a new hash and a new row.

### Push payload (negotiate)

```json
{
  "base_version": null,
  "schemas": {
    "Author": { "type": "object", "properties": { "name": { "type": "string" } } },
    "Pub": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "authorId": { "type": "string", "x-ref-type": "Author" }
      }
    }
  },
  "manifest": [{ "id": "auth-1", "type": "Author", "hash": "abc123..." }]
}
```

The server replies with the record hashes it doesn't have; the client streams just those records (NDJSON) and commits.

### Relationship annotations

Fields that hold record IDs of another type use `"x-ref-type": "TypeName"` to document the relationship. This enables linked-record navigation in the UI and helps LLMs understand the relational graph.

### Schema labeling

Schemas can be labeled post-hoc with human-readable names or URIs (e.g. `schema.org/Person`, `dc.author.v1`). Labels enable discovery across collections without upfront coordination.

- `POST /api/schemas/:id/labels` - Add a label
- `DELETE /api/schemas/:id/labels/:label` - Remove a label
- `GET /api/schemas?label=...` - Search by label
- Labels are injected as `x-underlay-labels` in schema exports (opt-out via `?raw=true`)

### Versioning semantics

- **Major bump**: Schema set changed (type added, removed, or schema modified)
- **Minor bump**: Records changed, schema set identical
- **Patch bump**: Only metadata changed (readme, message)

## Deployment

### Infrastructure

- **Hetzner** - Single box (8 vCPU, 16GB RAM) running Docker Swarm
- **Caddy** - Host-level reverse proxy, TLS via `tls internal` (Cloudflare Full mode)
- **Cloudflare** - DNS + CDN + DDoS protection
- **R2** - Object storage (zero egress fees), single bucket with prefixes:
  - `files/` - Content-addressed immutable uploads
  - `_backups/` - Compressed Postgres dumps

### Stacks

Two Docker Swarm stacks run on the same box:

| Stack           | Domain           | Host Port | Purpose    |
| --------------- | ---------------- | --------- | ---------- |
| `underlay-prod` | www.underlay.org | 3001      | Production |
| `underlay-dev`  | dev.underlay.org | 3000      | Staging    |

Container-internal port is always 3000. Host port is configured via `PORT` in .env files.

### CI/CD Flow

1. Push to `main` → deploys to `dev.underlay.org`
2. Create a release/tag → deploys to `www.underlay.org`
3. Manual dispatch → choose environment

The workflow: build Docker image → push to GHCR → decrypt env file for `DEPLOY_HOST` → SSH to server → `docker stack deploy` → wait for healthy rollout.

Required GitHub secrets: `SSH_PRIVATE_KEY`, `SSH_USER`, `GHCR_USER`, `GHCR_TOKEN`, `SOPS_AGE_SECRET_KEY`.

### Docker Compose Files

| File                          | Purpose                                        |
| ----------------------------- | ---------------------------------------------- |
| `docker-compose.yml`          | Deployed stacks (prod & dev via Swarm)         |
| `docker-compose.local.yml`    | Local development (source-mounted, hot reload) |
| `docker-compose.withauth.yml` | Self-hosted: app + bundled KF Auth stack       |

### Self-Hosting

Run the Underlay with a bundled auth server (no external auth provider needed):

```bash
DOMAIN=https://my-instance.com docker compose -f docker-compose.withauth.yml up
```

This starts Postgres, KF Auth (auth + account), the Underlay app, and Caddy with TLS. On first boot, secrets are auto-generated. Set `SMTP_*` vars for email delivery.

Supporting files live in `selfhost/` (Caddyfile, Postgres init script).

## Environment Variables

### Core

| Variable         | Description                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`   | PostgreSQL connection string                                                                           |
| `SESSION_SECRET` | Secret for signing session cookies (**required in production** — the app throws at startup without it) |
| `PORT`           | Server port (default: 3000)                                                                            |
| `APP_URL`        | Public base URL of this instance (default: `http://localhost:4100`)                                    |

### S3 storage

| Variable          | Description                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `S3_BUCKET`       | S3 bucket name                                                                                      |
| `S3_REGION`       | S3 region (`auto` for R2)                                                                           |
| `S3_ENDPOINT`     | S3 endpoint URL                                                                                     |
| `S3_ACCESS_KEY`   | S3 access key                                                                                       |
| `S3_SECRET_KEY`   | S3 secret key                                                                                       |
| `ASSETS_BASE_URL` | Public base URL for uploaded assets like avatars (optional, default: `https://assets.underlay.org`) |

### Auth (KF Auth OIDC)

| Variable                   | Description                                                                      |
| -------------------------- | -------------------------------------------------------------------------------- |
| `OIDC_ISSUER_URL`          | KF Auth issuer URL                                                               |
| `OIDC_ISSUER_INTERNAL_URL` | Issuer URL for server-to-server calls (optional, defaults to `OIDC_ISSUER_URL`)  |
| `OIDC_CLIENT_ID`           | OAuth client ID (default: `kf_underlay`)                                         |
| `OIDC_CLIENT_SECRET`       | OAuth client secret                                                              |
| `OIDC_ACCOUNT_URL`         | KF Account UI URL (account management links)                                     |
| `AUTH_INTERNAL_API_KEY`    | Key for KF Auth's internal API (optional; also authenticates `/api/kf/summary`)  |
| `AUTH_INTERNAL_API_URL`    | KF Auth internal API base URL (optional, defaults to `OIDC_ISSUER_INTERNAL_URL`) |
| `INTERNAL_API_TOKEN`       | Legacy `x-internal-token` for internal service calls (optional)                  |

### Optional features

| Variable                    | Description                                                               |
| --------------------------- | ------------------------------------------------------------------------- |
| `ARK_DEFAULT_NAAN`          | Default NAAN for ARK identifiers                                          |
| `CF_ACCOUNT_ID`             | Cloudflare account ID for LLM-powered natural-language SQL (optional)     |
| `CF_API_TOKEN`              | Cloudflare API token for LLM-powered natural-language SQL (optional)      |
| `UNDERLAY_MODE`             | `origin` (default) or `mirror` — read-only mirror of an upstream instance |
| `UNDERLAY_NODE_NAME`        | Display name for this mirror node                                         |
| `UNDERLAY_UPSTREAM`         | Upstream Underlay URL to mirror from                                      |
| `UNDERLAY_UPSTREAM_API_KEY` | API key for the upstream instance                                         |
| `UNDERLAY_SYNC_SCHEDULE`    | Cron schedule for mirror sync (default: `0 0 * * 0`)                      |
| `MIRROR_ADMIN_EMAILS`       | Comma-separated emails allowed to use the mirror admin UI/API             |
| `CORS_ORIGINS`              | Extra allowed CORS origins, comma-separated (APP_URL is always allowed)   |
| `MAX_FILE_UPLOAD_BYTES`     | Max file upload size in bytes (default: 100 MB)                           |

`NODE_ENV` is set in `docker-compose.yml` `environment:` block (not in .env files).

## Scripts

```bash
# Development
pnpm dev              # Start full local stack (Docker)
pnpm dev:app          # Start server without Docker
pnpm build            # Build for production (client + SSR)
pnpm start            # Start production server
pnpm cli <command>    # Run CLI locally (e.g. pnpm cli init, pnpm cli add)

# Code quality
pnpm typecheck        # TypeScript type checking
pnpm lint             # Lint with oxlint
pnpm fmt              # Format with oxfmt
pnpm fmt:check        # Check formatting
pnpm test             # Run tests (Vitest)
pnpm test:watch       # Run tests in watch mode

# Database
pnpm db:generate      # Generate Drizzle migrations from schema changes
pnpm db:migrate       # Run pending migrations
pnpm db:seed          # Seed database

# Tools
pnpm tool:backup       # Manual database backup to S3
pnpm tool:restore      # List S3 backups; restore one with `-- <s3-key> --yes`
pnpm tool:pruneBackups # Prune old backups (supports `-- --dry-run`)
pnpm tool:seed-mirror  # Seed a mirror instance (admin org only)

# Secrets (SOPS + age)
pnpm secrets:encrypt:local  # Encrypt .env.local → .env.local.enc
pnpm secrets:encrypt:prod   # Encrypt .env.prod → .env.prod.enc
pnpm secrets:encrypt:dev    # Encrypt .env.dev → .env.dev.enc
pnpm secrets:decrypt:local  # Decrypt .env.local.enc → .env.local
pnpm secrets:decrypt:prod   # Decrypt .env.prod.enc → .env.prod
pnpm secrets:decrypt:dev    # Decrypt .env.dev.enc → .env.dev
```

## Maintenance Checklist

When adding or changing features, update these locations:

| What              | Where                                   | Purpose                                    |
| ----------------- | --------------------------------------- | ------------------------------------------ |
| Protocol spec     | `src/routes/protocol.tsx`               | Protocol documentation page                |
| API documentation | `public/.well-known/ai.txt`             | Machine-readable docs for LLMs and bots    |
| Concepts          | `src/routes/docs/concepts.tsx`          | Core concepts explanation                  |
| API reference     | `src/routes/docs/api/*.tsx`             | Endpoint-level docs with examples          |
| Integration guide | `src/routes/docs/integration.tsx`       | Developer onboarding guide                 |
| Quick start       | `src/routes/docs/quickstart.tsx`        | Getting started tutorial                   |
| Self-hosting      | `src/routes/docs/self-host.tsx`         | Deployment instructions                    |
| DB schema         | `src/db/schema.ts` → `pnpm db:generate` | Schema changes need a migration            |
| Core library      | `src/lib/core/`                         | Hashing, semver, privacy, validation       |
| CLI commands      | `src/cli/commands/`                     | Local versioning and sync                  |
| Schema discovery  | `src/api/schemas.ts`                    | Schema search, labeling, cross-referencing |
| Encrypted secrets | `.env.{local,dev,prod}.enc`             | Re-encrypt after changing .env files       |

### Privacy features

Privacy is part of the protocol. The system supports three levels (type-level, field-level, record-level) via `"private": true` annotations. When changing how privacy works, update:

- `src/lib/core/privacy.ts` - pure filtering functions (shared by server and CLI)
- `src/api/versions.ts` - API-level filtering
- `src/api/files.ts` - file access checks
- `src/api/schemas.ts` - public schema filtering
- `src/routes/protocol.tsx` - protocol spec
- `public/.well-known/ai.txt` - Privacy section
- `src/routes/docs/concepts.tsx` - Privacy section
- `src/routes/docs/integration.tsx` - Privacy section

## License

MIT
