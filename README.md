<h1><img src="public/favicon.svg" height="32" alt="" />&nbsp; Underlay</h1>

Underlay is a versioned, content-addressed registry for structured public knowledge. Data published on Underlay is preserved, API accessible, and becomes the basis for any number of applications that can be built on top.

Structured knowledge that lives inside institutional repositories and databases can be published as Underlay collections, making it available as the foundation for discovery tools, LLM integrations, custom interfaces, and any other application that needs reliable access to well-described data.

Underlay is built by [Knowledge Futures](https://www.knowledgefutures.org), a 501(c)(3) public charity dedicated to building open-source knowledge infrastructure.

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

## Architecture

| Layer        | Technology                                                    |
| ------------ | ------------------------------------------------------------- |
| Server       | Hono 4 + @hono/node-server                                    |
| Frontend     | React 19 + React Router v7 (SSR + client hydration)           |
| Styling      | Tailwind CSS 4 (@tailwindcss/vite)                            |
| Build        | Vite 6 (client + SSR bundles)                                 |
| Database     | PostgreSQL 17 + Drizzle ORM                                   |
| File Storage | S3-compatible (Cloudflare R2 in production)                    |
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
├── route-gen.ts          # Filesystem → route pattern conversion
├── loaders.server.ts     # Server-side data loaders per route
├── api/                  # API route handlers (named exports)
│   ├── auth.server.ts    # Auth middleware + session helpers
│   ├── accounts.ts       # Signup, login, API key CRUD, orgs
│   ├── collections.ts    # Collection CRUD
│   ├── versions.ts       # Version push/pull/diff + privacy filtering
│   ├── uploads.ts        # Batch upload sessions
│   ├── files.ts          # Content-addressed file storage
│   ├── schemas.ts        # Schema discovery, search, labeling
│   ├── ark.ts            # ARK identifier management
│   ├── admin.ts          # Admin endpoints (mirror mode)
│   ├── query.ts          # SQL query tool
│   └── health.ts         # Health check
├── db/
│   ├── schema.ts         # Drizzle table definitions
│   ├── client.server.ts  # Database client
│   ├── migrate.ts        # Migration runner
│   ├── seed.ts           # Seed data
│   └── migrations/       # Generated SQL migrations
├── routes/               # React pages (filesystem routing)
│   ├── index.tsx         # Landing page
│   ├── explore.tsx       # Browse public collections
│   ├── dashboard.tsx     # User's collections
│   ├── settings/         # Account settings + API keys
│   ├── schemas/          # Schema browser
│   ├── blog/             # Blog
│   ├── docs/             # Documentation
│   └── [owner]/          # Dynamic owner routes
│       ├── index.tsx
│       ├── [collection]/
│       │   ├── index.tsx
│       │   ├── versions.tsx
│       │   ├── v/[n].tsx
│       │   ├── diff.tsx
│       │   └── settings.tsx
├── components/           # Shared React components
├── lib/
│   ├── s3.ts             # S3 client
│   ├── ark.ts            # ARK identifier utilities
│   ├── version-helpers.server.ts  # Shared schema/version helpers
│   └── page-utils.ts     # SSR utilities
├── styles/global.css     # Tailwind theme
public/
├── .well-known/ai.txt    # Machine-readable API docs
tools/
├── backupDb.ts           # Postgres backup → S3
└── cron.ts               # Scheduled task runner
```

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

| File                       | Purpose                                               |
| -------------------------- | ----------------------------------------------------- |
| `docker-compose.yml`       | Deployed stacks (prod & dev via Swarm)                |
| `docker-compose.local.yml` | Local development (source-mounted, hot reload)        |

## Environment Variables

| Variable         | Description                        |
| ---------------- | ---------------------------------- |
| `DATABASE_URL`   | PostgreSQL connection string       |
| `SESSION_SECRET` | Secret for signing session cookies |
| `PORT`           | Server port (default: 3000)        |
| `S3_BUCKET`      | S3 bucket name                     |
| `S3_REGION`      | S3 region (`auto` for R2)          |
| `S3_ENDPOINT`    | S3 endpoint URL                    |
| `S3_ACCESS_KEY`  | S3 access key                      |
| `S3_SECRET_KEY`  | S3 secret key                      |

`NODE_ENV` is set in `docker-compose.yml` `environment:` block (not in .env files).

## Scripts

```bash
# Development
pnpm dev              # Start full local stack (Docker)
pnpm dev:app          # Start server without Docker
pnpm build            # Build for production (client + SSR)
pnpm start            # Start production server

# Code quality
pnpm typecheck        # TypeScript type checking
pnpm lint             # Lint with oxlint
pnpm fmt              # Format with oxfmt
pnpm fmt:check        # Check formatting

# Database
pnpm db:generate      # Generate Drizzle migrations from schema changes
pnpm db:migrate       # Run pending migrations
pnpm db:seed          # Seed database

# Tools
pnpm tool:backup      # Manual database backup to S3
pnpm tool:restore     # Restore database from backup
pnpm tool:pruneBackups # Prune old backups

# Secrets (SOPS + age)
pnpm secrets:encrypt:local  # Encrypt .env.local → .env.local.enc
pnpm secrets:encrypt:prod   # Encrypt .env.prod → .env.prod.enc
pnpm secrets:encrypt:dev    # Encrypt .env.dev → .env.dev.enc
pnpm secrets:decrypt:local  # Decrypt .env.local.enc → .env.local
pnpm secrets:decrypt:prod   # Decrypt .env.prod.enc → .env.prod
pnpm secrets:decrypt:dev    # Decrypt .env.dev.enc → .env.dev
```

## Schema System

Underlay uses **globally deduplicated, content-addressed schemas** for record validation and interoperability.

### How it works

- Each record type in a collection has its own JSON Schema, stored as an immutable, content-addressed row in the global `schemas` table.
- A version declares its full set of type→schema bindings via the `version_schemas` join table.
- If two collections define the same fields and types for a record type, they produce the same schema hash. Alignment is automatic.
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

- `POST /api/schemas/:id/labels` - Add a label
- `DELETE /api/schemas/:id/labels/:label` - Remove a label
- `GET /api/schemas?label=...` - Search by label
- Labels are injected as `x-underlay-labels` in schema exports (opt-out via `?raw=true`)

### Schema discovery API

| Endpoint                                    | Purpose                                                       |
| ------------------------------------------- | ------------------------------------------------------------- |
| `GET /api/schemas`                          | Global search (filter by `q`, `slug`, `label`, `schema_hash`) |
| `GET /api/schemas/:id`                      | Single schema with labels + usage info                        |
| `GET /api/collections/:owner/:slug/schemas` | Collection's schemas (with label enrichment)                  |

### Versioning semantics

- **Major bump**: Schema set changed (type added, removed, or schema modified)
- **Minor bump**: Records changed, schema set identical
- **Patch bump**: Only metadata changed (readme, message)

## Maintenance Checklist

When adding or changing features, update these locations:

| What              | Where                                   | Purpose                                    |
| ----------------- | --------------------------------------- | ------------------------------------------ |
| API documentation | `public/.well-known/ai.txt`             | Machine-readable docs for LLMs and bots    |
| Concepts          | `src/routes/docs/concepts.tsx`          | Core concepts explanation                  |
| API reference     | `src/routes/docs/api/*.tsx`             | Endpoint-level docs with examples          |
| Integration guide | `src/routes/docs/integration.tsx`       | Developer onboarding guide                 |
| Quick start       | `src/routes/docs/quickstart.tsx`        | Getting started tutorial                   |
| Self-hosting      | `src/routes/docs/self-host.tsx`         | Deployment instructions                    |
| DB schema         | `src/db/schema.ts` → `pnpm db:generate` | Schema changes need a migration            |
| Schema discovery  | `src/api/schemas.ts`                    | Schema search, labeling, cross-referencing |
| Encrypted secrets | `.env.enc` / `.env.dev.enc`             | Re-encrypt after changing .env files       |

### Privacy features

The system supports three levels of privacy (type-level, field-level, record-level) via `"private": true` annotations in per-type schemas. When changing how privacy works, update:

- `src/api/versions.ts` - filtering logic (reads from `version_schemas` JOIN `schemas`)
- `src/api/files.ts` - file access checks
- `src/api/schemas.ts` - public schema filtering
- `public/.well-known/ai.txt` - Privacy section
- `src/routes/docs/concepts.tsx` - Privacy section
- `src/routes/docs/api/versions.tsx` - Push endpoint docs

## License

MIT
