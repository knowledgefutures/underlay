import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

const quickStart = `DOMAIN=https://your-domain.com docker compose -f docker-compose.withauth.yml up -d`

const localStart = `docker compose -f docker-compose.withauth.yml up -d`

const envExample = `# Required
DOMAIN=https://your-domain.com

# Optional: email delivery (for password resets, invitations)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_FROM=noreply@your-domain.com
SMTP_USER=apikey
SMTP_PASS=your-smtp-password

# Optional: social login providers
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ORCID_CLIENT_ID=...
ORCID_CLIENT_SECRET=...`

const externalS3 = `# In docker-compose.withauth.yml, remove the minio and minio-init services,
# then add these to the app service's environment block.
#
# Two buckets are required:
#   S3_BUCKET        PRIVATE. Collection files. Public access must be OFF — reads
#                    go through the API, which access-checks and then returns a
#                    short-lived presigned URL.
#   S3_PUBLIC_BUCKET world-readable. Org avatars, served directly from
#                    ASSETS_BASE_URL.
S3_BUCKET: your-private-bucket
S3_PUBLIC_BUCKET: your-public-bucket
S3_REGION: us-east-1
S3_ENDPOINT: https://your-account-id.r2.cloudflarestorage.com  # omit for AWS S3
S3_ACCESS_KEY: your-access-key      # must have read+write on BOTH buckets
S3_SECRET_KEY: your-secret-key
ASSETS_BASE_URL: https://assets.example.org   # public base URL of S3_PUBLIC_BUCKET
S3_PRESIGN_TTL_SECONDS: 300         # optional; presigned file URL lifetime`

const resetCmd = `docker compose -f docker-compose.withauth.yml down -v
docker compose -f docker-compose.withauth.yml up -d`

export default function DocsSelfHost() {
  return (
    <DocsLayout title="Self-Hosting">
      <p>
        The Underlay{' '}
        <Link to="/protocol" className="text-link underline">
          protocol
        </Link>{' '}
        is an open specification. This repository is the reference implementation, but anyone can
        build an Underlay-compatible server tailored to their infrastructure, language, or use case,
        as long as it implements the protocol (content-addressed records, hash negotiation,
        immutable versioning). The protocol is the contract; the implementation is yours.
      </p>
      <p>
        What follows is how to self-host <em>this</em> implementation. It ships with a
        self-contained Docker Compose setup that bundles everything you need: the app, auth server,
        PostgreSQL, S3-compatible storage, and a reverse proxy. One command, no external
        dependencies.
      </p>

      <h2>What gets deployed</h2>
      <ul>
        <li>
          <strong>Underlay app</strong>: the main application (API + web UI)
        </li>
        <li>
          <strong>KF Auth</strong>: authentication server (OAuth2/OIDC) + account management UI
        </li>
        <li>
          <strong>PostgreSQL 16</strong>: two databases, one for auth and one for the app
        </li>
        <li>
          <strong>MinIO</strong>: S3-compatible object storage (replaceable with external S3). Two
          buckets are created: <code>underlay</code>, which is <strong>private</strong> and holds
          collection files, and <code>underlaypublic</code>, which is world-readable and holds org
          avatars. Collection files are never served directly from storage — the API access-checks
          each request and returns a short-lived presigned URL.
        </li>
        <li>
          <strong>Caddy</strong>: reverse proxy with automatic TLS
        </li>
      </ul>
      <p>
        On first boot, an init container auto-generates all secrets (session keys, OAuth client
        credentials, S3 credentials). No manual secret management required.
      </p>

      <h2>Requirements</h2>
      <ul>
        <li>
          <strong>Docker</strong> and <strong>Docker Compose</strong> (v2)
        </li>
        <li>
          A server with at least <strong>2 GB RAM</strong> and <strong>10 GB disk</strong>
        </li>
        <li>
          A domain name pointed at your server (for TLS), or <code>localhost</code> for local
          testing
        </li>
      </ul>

      <h2>Quick start</h2>
      <p>Clone the repo and run:</p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{quickStart}</code>
      </pre>
      <p>
        That's it. Caddy handles TLS automatically via Let's Encrypt. Visit your domain to create
        your first account.
      </p>
      <p>
        For local testing without a domain, omit <code>DOMAIN</code>. It defaults to{' '}
        <code>http://localhost</code>:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{localStart}</code>
      </pre>

      <h2>Configuration</h2>
      <p>
        Set environment variables in your shell or create a <code>.env</code> file next to the
        compose file. Only <code>DOMAIN</code> is required; everything else has sensible defaults or
        is auto-generated.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{envExample}</code>
      </pre>

      <h3>Social login</h3>
      <p>
        Without social login configured, users sign up and log in with email/password. To enable
        GitHub, Google, or ORCID login, set the corresponding client ID and secret. You'll need to
        register an OAuth app with each provider, using{' '}
        <code>{'https://your-domain.com/auth/callback/<provider>'}</code> as the callback URL.
      </p>

      <h2>Using external S3</h2>
      <p>
        The bundled MinIO service works out of the box, but you can replace it with any
        S3-compatible storage (AWS S3, Cloudflare R2, DigitalOcean Spaces, etc.):
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{externalS3}</code>
      </pre>
      <p>
        Also remove the <code>minio-init</code> service dependency from the <code>app</code>{' '}
        service. The <code>S3_ENDPOINT</code> variable is only needed for non-AWS providers; omit it
        for standard AWS S3.
      </p>

      <h2>Data and persistence</h2>
      <p>All state is in Docker volumes:</p>
      <ul>
        <li>
          <code>pgdata</code>: PostgreSQL databases (auth + app)
        </li>
        <li>
          <code>minio-data</code>: uploaded files (if using bundled MinIO)
        </li>
        <li>
          <code>withauth-config</code>: auto-generated secrets and config (created once on first
          boot)
        </li>
        <li>
          <code>caddy-data</code>: TLS certificates
        </li>
      </ul>
      <p>
        To completely reset and start fresh, remove all volumes and re-run. The init container will
        regenerate secrets:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{resetCmd}</code>
      </pre>

      <h2>Updating</h2>
      <p>
        Pull new images and restart. The app runs database migrations automatically on startup. No
        manual migration step needed.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>
          {`docker compose -f docker-compose.withauth.yml pull\ndocker compose -f docker-compose.withauth.yml up -d`}
        </code>
      </pre>

      <h2>Architecture</h2>
      <p>Caddy listens on ports 80 and 443 and routes requests by path:</p>
      <ul>
        <li>
          <code>/auth/*</code> → KF Auth server (authentication, OAuth2)
        </li>
        <li>
          <code>/account/*</code> → KF Auth account UI (profile, password, sessions)
        </li>
        <li>
          Everything else → Underlay app (API at <code>/api/*</code>, web UI for all other paths)
        </li>
      </ul>
      <p>
        The app server handles both the JSON API and server-side rendered React UI on a single port.
        All services communicate internally over a Docker network; only Caddy is exposed to the
        internet.
      </p>

      <h2>Source code</h2>
      <p>The self-hosting setup lives in the main repo:</p>
      <ul>
        <li>
          <code>docker-compose.withauth.yml</code>: the compose file
        </li>
        <li>
          <code>selfhost/Caddyfile</code>: Caddy reverse proxy config
        </li>
        <li>
          <code>selfhost/init-db.sh</code>: Postgres init script (creates the app database)
        </li>
      </ul>
      <p>
        Report issues at{' '}
        <a href="https://github.com/knowledgefutures/underlay">
          github.com/knowledgefutures/underlay
        </a>
        . Built by <a href="https://www.knowledgefutures.org">Knowledge Futures</a>, a 501(c)(3)
        public charity.
      </p>
    </DocsLayout>
  )
}
