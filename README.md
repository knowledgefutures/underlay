# Underlay

A versioned, content-addressed registry for knowledge collections. Apps publish snapshots of their data to Underlay; Underlay preserves them, deduplicates files, and exposes them via a stable HTTPS API.

**Underlay is the archive underneath your app.**

Built by [Knowledge Futures](https://www.knowledgefutures.org), a 501(c)(3) nonprofit.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 24+ (LTS)
- [Docker](https://www.docker.com/) and Docker Compose

### Development

```bash
# Clone and start everything (Postgres, MinIO, app)
git clone https://github.com/knowledgefutures/underlay.git
cd underlay
./dev.sh
```

This starts:
- **PostgreSQL 16** on port 5432
- **MinIO** (S3-compatible storage) on ports 9000/9001
- **Underlay** on port 4321 (frontend) and port 3000 (API)

The dev script auto-creates `.env.dev` from defaults if one doesn't exist.

### Without Docker

```bash
npm install

# Set up your own Postgres and S3, then:
cp .env.test .env.dev
# Edit .env.dev with your connection strings

npm run db:migrate
npm run db:seed
npm run dev:server
```

### Default Seed User

The seed creates an admin account you can log in with:
- **Email:** admin@underlay.org
- **Password:** admin

It also creates a "Knowledge Futures" org with three sample collections.

## Architecture

| Layer | Technology |
|-------|-----------|
| Frontend | Astro 6 SSR + React 19 islands + Tailwind CSS 4 |
| API | Fastify 5 (TypeScript) |
| Database | PostgreSQL 16 + Drizzle ORM |
| File Storage | S3-compatible (AWS S3 / MinIO / R2) |
| Auth | Session cookies (web) + API keys (programmatic) |
| Deployment | Docker (Alpine), multi-stage build |

## Project Structure

```
src/
├── api/                  # Fastify API server
│   ├── plugins/auth.ts   # Authentication (API keys + sessions)
│   ├── routes/           # API route handlers
│   │   ├── accounts.ts   # Signup, login, API key CRUD
│   │   ├── collections.ts    # Collection CRUD
│   │   ├── versions.ts   # Version push/pull/diff
│   │   ├── files.ts      # Content-addressed file storage
│   │   └── health.ts     # Health check
│   └── server.ts         # Fastify entry point
├── db/
│   ├── schema.ts         # Drizzle table definitions
│   ├── index.ts          # Database client
│   ├── migrate.ts        # Migration runner
│   ├── seed.ts           # Seed data (--force to re-seed)
│   └── migrations/       # Generated SQL migrations
├── layouts/
│   ├── Base.astro        # Root HTML layout
│   └── Docs.astro        # Documentation page layout
├── lib/
│   └── s3.ts             # S3 client utilities
├── pages/
│   ├── index.astro       # Landing page
│   ├── explore.astro     # Browse public collections
│   ├── connect.astro     # Integration guide (for devs and LLMs)
│   ├── login.astro       # Login form
│   ├── signup.astro      # Signup form
│   ├── dashboard.astro   # Authenticated user's collections
│   ├── settings/         # Account settings + API key management
│   ├── blog/             # Blog posts
│   ├── docs/             # Documentation (concepts, quickstart, API ref, self-hosting)
│   └── [owner]/          # Dynamic routes
│       ├── index.astro           # /:owner — account profile
│       └── [collection]/
│           ├── index.astro       # /:owner/:collection — collection overview
│           └── v/[n].astro       # /:owner/:collection/v/:n — version detail
├── styles/
│   └── global.css        # Tailwind theme (parchment/ink palette)
tools/
├── backupDb.ts           # Postgres backup → S3
└── cron.ts               # Scheduled task runner
```

## API

All endpoints are under `/api`. Auth via `Authorization: Bearer <api_key>` for writes.

### Accounts
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/accounts/signup` | Create account |
| POST | `/api/accounts/login` | Log in (sets session cookie) |
| POST | `/api/accounts/logout` | Log out |
| GET | `/api/accounts/me` | Current user |
| GET | `/api/accounts/:slug` | Public profile |
| POST | `/api/accounts/keys` | Create API key |
| GET | `/api/accounts/keys` | List API keys |
| DELETE | `/api/accounts/keys/:id` | Revoke API key |

### Collections
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/collections` | Browse public collections |
| POST | `/api/accounts/:owner/collections` | Create collection |
| GET | `/api/collections/:owner/:slug` | Collection metadata |
| PATCH | `/api/collections/:owner/:slug` | Update collection |
| DELETE | `/api/collections/:owner/:slug` | Delete collection |
| GET | `/api/accounts/:owner/collections` | List owner's collections |

### Versions
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/collections/:owner/:slug/versions` | Push a version |
| GET | `/api/collections/:owner/:slug/versions` | List versions |
| GET | `/api/collections/:owner/:slug/versions/latest` | Latest version |
| GET | `/api/collections/:owner/:slug/versions/:n` | Get version |
| GET | `/api/collections/:owner/:slug/versions/:n/records` | Get records |
| GET | `/api/collections/:owner/:slug/versions/:n/manifest` | Get manifest |
| GET | `/api/collections/:owner/:slug/versions/:n/diff` | Diff versions |

### Files
| Method | Endpoint | Description |
|--------|----------|-------------|
| HEAD | `/api/collections/:owner/:slug/files/:hash` | Check existence |
| GET | `/api/collections/:owner/:slug/files/:hash` | Download |
| PUT | `/api/collections/:owner/:slug/files/:hash` | Upload |

## Scripts

```bash
npm run dev              # Start full dev environment (Docker)
npm run dev:server       # Start Astro + API (no Docker)
npm run build            # Build for production
npm run start            # Start production server

npm run db:generate      # Generate Drizzle migrations
npm run db:migrate       # Run migrations
npm run db:seed          # Seed database (--force to re-seed)

npm run tool:backup      # Manual database backup to S3

npm run secrets:encrypt  # Encrypt .env with SOPS
npm run secrets:decrypt  # Decrypt .env.enc with SOPS
```

## Deployment

### Docker

```bash
docker build -t underlay .
docker compose up -d
```

The production `docker-compose.yml` runs three services:
- **postgres** — PostgreSQL 16 with persistent volume
- **app** — Migrations + Astro SSR + Fastify API
- **cron** — Scheduled database backups

### CI/CD

Push to `main` triggers the GitHub Actions workflow:
1. Build Docker image → push to GHCR
2. SSH to server → pull → decrypt secrets → `docker compose up`

Required GitHub secrets: `SSH_PRIVATE_KEY`, `SSH_HOST`, `SSH_USER`, `GHCR_USER`, `GHCR_TOKEN`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Secret for signing session cookies |
| `APP_URL` | Public frontend URL (for CORS) |
| `API_PORT` | Fastify API port (default: 3000) |
| `S3_BUCKET` | S3 bucket name |
| `S3_REGION` | S3 region |
| `S3_ENDPOINT` | S3 endpoint (for MinIO, R2, etc.) |
| `S3_ACCESS_KEY` | S3 access key |
| `S3_SECRET_KEY` | S3 secret key |

## License

MIT
