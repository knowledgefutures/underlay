# Underlay

A versioned, content-addressed registry for structured knowledge. Apps publish snapshots of their data to Underlay; Underlay preserves them, deduplicates files, and exposes them via a stable HTTPS API.

Built by [Knowledge Futures](https://www.knowledgefutures.org), a 501(c)(3) nonprofit.

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
- **PostgreSQL 16** on port 5433 (host) → 5432 (container)
- **MinIO** (S3-compatible storage) on ports 9000/9001
- **Underlay** on port 4321 (Astro SSR) and port 3000 (Fastify API)

The dev script auto-creates `.env.local` from `.env.test` defaults if one doesn't exist.

### Without Docker

```bash
npm install
cp .env.test .env.local
# Edit .env.local with your Postgres and S3 connection strings
npm run db:migrate
npm run db:seed
npm run dev:server
```

### Default Seed User

- **Email:** admin@underlay.org
- **Password:** admin

Also creates a "Knowledge Futures" org with sample collections.

## Architecture

| Layer | Technology |
|-------|-----------|
| Frontend | Astro 6 SSR + React 19 islands + Tailwind CSS 4 |
| API | Fastify 5 (TypeScript), always binds to port 3000 |
| Database | PostgreSQL 16 + Drizzle ORM |
| File Storage | Cloudflare R2 (prod) / MinIO (dev) — S3-compatible |
| Auth | Session cookies (web) + API keys (programmatic) |
| Deployment | Docker Swarm on Hetzner, Caddy reverse proxy, Cloudflare DNS |
| CI/CD | GitHub Actions → GHCR → SSH → `docker stack deploy` |
| Secrets | SOPS + age encryption |

## Project Structure

```
src/
├── api/                  # Fastify API server (port 3000)
│   ├── plugins/auth.ts   # Auth (API keys + session cookies)
│   ├── routes/
│   │   ├── accounts.ts   # Signup, login, API key CRUD, orgs
│   │   ├── collections.ts    # Collection CRUD
│   │   ├── versions.ts   # Version push/pull/diff + privacy filtering
│   │   ├── files.ts      # Content-addressed file storage
│   │   ├── schemas.ts    # Schema discovery, search, labeling
│   │   └── health.ts     # Health check
│   └── server.ts         # Fastify entry point
├── db/
│   ├── schema.ts         # Drizzle table definitions
│   ├── index.ts          # Database client
│   ├── migrate.ts        # Migration runner (retries on DNS failures)
│   ├── seed.ts           # Seed data
│   └── migrations/       # Generated SQL migrations
├── layouts/              # Astro layouts (Base, Docs, BlogPost)
├── components/           # React islands + Astro components
├── lib/
│   ├── s3.ts             # S3 client (upload, download, head, list, delete)
│   └── page-utils.ts     # SSR utilities
├── pages/
│   ├── index.astro       # Landing page
│   ├── explore.astro     # Browse public collections
│   ├── login/signup.astro
│   ├── dashboard.astro   # User's collections
│   ├── settings/         # Account settings + API key management
│   ├── blog/             # Markdown blog posts
│   ├── docs/             # Documentation (concepts, quickstart, API ref, self-hosting)
│   └── [owner]/          # Dynamic routes
│       ├── index.astro           # Profile page
│       ├── settings.astro        # Account/org settings
│       └── [collection]/
│           ├── index.astro       # Collection overview
│           ├── versions.astro    # Version history
│           ├── diff.astro        # Version diff viewer
│           ├── settings.astro    # Collection settings
│           └── v/[n].astro       # Version detail
├── styles/global.css     # Tailwind theme (parchment/ink palette)
public/
├── .well-known/ai.txt   # Machine-readable API docs (for LLMs/bots)
tools/
├── backupDb.ts           # Postgres backup → S3 (_backups/ prefix)
└── cron.ts               # Scheduled task runner (daily backups)
```

## Deployment

### Infrastructure

- **Hetzner** — Single box (8 vCPU, 16GB RAM) running Docker Swarm
- **Caddy** — Host-level reverse proxy, TLS via `tls internal` (Cloudflare Full mode)
- **Cloudflare** — DNS + CDN + DDoS protection
- **R2** — Object storage (zero egress fees), single bucket with prefixes:
  - `files/` — Content-addressed immutable uploads
  - `_backups/` — Compressed Postgres dumps

### Stacks

Two Docker Swarm stacks run on the same box:

| Stack | Domain | Host Ports | Purpose |
|-------|--------|-----------|---------|
| `underlay-prod` | www.underlay.org | 4322 (SSR), 3001 (API) | Production |
| `underlay-dev` | dev.underlay.org | 4321 (SSR), 3000 (API) | Staging |

Container-internal ports are always fixed: 4321 (Astro) and 3000 (Fastify).
Host ports are configured via `APP_PORT` and `API_PORT` in .env files (compose-only variables).

### CI/CD Flow

1. Push to `main` → deploys to `dev.underlay.org`
2. Create a release/tag → deploys to `www.underlay.org`
3. Manual dispatch → choose environment

The workflow: build Docker image → push to GHCR → SSH to server → decrypt secrets → `docker stack deploy` → wait for healthy rollout.

Required GitHub secrets: `SSH_PRIVATE_KEY`, `SSH_HOST_DEV`, `SSH_HOST_PROD`, `SSH_USER`, `GHCR_USER`, `GHCR_TOKEN`.

### Docker Compose Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Deployed stacks (prod & dev via Swarm) |
| `docker-compose.local.yml` | Local development (source-mounted, MinIO, hot reload) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Secret for signing session cookies |
| `APP_PORT` | Host-published port for Astro SSR (compose only, default: 4322) |
| `API_PORT` | Host-published port for Fastify API (compose only, default: 3001) |
| `S3_BUCKET` | S3 bucket name |
| `S3_REGION` | S3 region (`auto` for R2) |
| `S3_ENDPOINT` | S3 endpoint URL |
| `S3_ACCESS_KEY` | S3 access key |
| `S3_SECRET_KEY` | S3 secret key |

`NODE_ENV` is set in `docker-compose.yml` `environment:` block (not in .env files).

## Scripts

```bash
# Development
npm run dev              # Start full local stack (Docker)
npm run dev:server       # Start Astro + API without Docker
npm run build            # Build for production

# Database
npm run db:generate      # Generate Drizzle migrations from schema changes
npm run db:migrate       # Run pending migrations
npm run db:seed          # Seed database

# Tools
npm run tool:backup      # Manual database backup to S3

# Secrets (SOPS + age)
npm run secrets:encrypt      # Encrypt .env → .env.enc
npm run secrets:encrypt:dev  # Encrypt .env.dev → .env.dev.enc
npm run secrets:decrypt      # Decrypt .env.enc → .env
npm run secrets:decrypt:dev  # Decrypt .env.dev.enc → .env.dev
```

## Schema System

Underlay uses **globally deduplicated, content-addressed schemas** for record validation and interoperability.

### How it works

- Each record type in a collection has its own JSON Schema, stored as an immutable, content-addressed row in the global `schemas` table.
- A version declares its full set of type→schema bindings via the `version_schemas` join table.
- If two collections define the same fields and types for a record type, they produce the same schema hash — alignment is automatic.
- Schemas are never modified. Evolving a type produces a new hash and a new row.

### Push payload

```json
{
  "schemas": {
    "Author": { "type": "object", "properties": { "name": { "type": "string" } } },
    "Pub": { "type": "object", "properties": { "title": { "type": "string" }, "authorId": { "type": "string", "x-ref-type": "Author" } } }
  },
  "changes": { "added": [...] }
}
```

### Relationship annotations

Fields that hold record IDs of another type use `"x-ref-type": "TypeName"` to document the relationship. This enables linked-record navigation in the UI and helps LLMs understand the relational graph.

### Schema labeling

Schemas can be labeled post-hoc with human-readable names or URIs (e.g. `schema.org/Person`, `dc.author.v1`). Labels enable discovery across collections without upfront coordination.

- `POST /api/schemas/:id/labels` — Add a label
- `DELETE /api/schemas/:id/labels/:label` — Remove a label
- `GET /api/schemas?label=...` — Search by label
- Labels are injected as `x-underlay-labels` in schema exports (opt-out via `?raw=true`)

### Schema discovery API

| Endpoint | Purpose |
|----------|--------|
| `GET /api/schemas` | Global search (filter by `q`, `slug`, `label`, `schema_hash`) |
| `GET /api/schemas/:id` | Single schema with labels + usage info |
| `GET /api/collections/:owner/:slug/schemas` | Collection's schemas (with label enrichment) |

### Versioning semantics

- **Major bump**: Schema set changed (type added, removed, or schema modified)
- **Minor bump**: Records changed, schema set identical
- **Patch bump**: Only metadata changed (readme, message)

## Maintenance Checklist

When adding or changing features, update these locations:

| What | Where | Purpose |
|------|-------|---------|
| API documentation | `public/.well-known/ai.txt` | Machine-readable docs for LLMs and bots |
| Concepts | `src/pages/docs/concepts.astro` | Core concepts explanation |
| API reference | `src/pages/docs/api/*.astro` | Endpoint-level docs with examples |
| Integration guide | `src/pages/docs/integration.astro` | Developer onboarding guide |
| Quick start | `src/pages/docs/quickstart.astro` | Getting started tutorial |
| Self-hosting | `src/pages/docs/self-host.astro` | Deployment instructions |
| DB schema | `src/db/schema.ts` → `npm run db:generate` | Schema changes need a migration |
| Schema discovery | `src/api/routes/schemas.ts` | Schema search, labeling, cross-referencing |
| Encrypted secrets | `.env.enc` / `.env.dev.enc` | Re-encrypt after changing .env files |

### Privacy features

The system supports three levels of privacy (type-level, field-level, record-level) via `"private": true` annotations in per-type schemas. When changing how privacy works, update:
- `src/api/routes/versions.ts` — filtering logic (reads from `version_schemas` JOIN `schemas`)
- `src/api/routes/files.ts` — file access checks
- `src/api/routes/schemas.ts` — public schema filtering
- `public/.well-known/ai.txt` — Privacy section
- `src/pages/docs/concepts.astro` — Privacy section
- `src/pages/docs/api/versions.astro` — Push endpoint docs

## License

MIT
