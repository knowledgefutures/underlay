import DocsLayout from '~/components/DocsLayout'

const devShCode = `git clone https://github.com/knowledgefutures/underlay.git
cd underlay
./dev.sh`

const secretsCode = `# Generate a keypair
age-keygen -o key.txt

# Add the public key to .sops.yaml, then:
npm run secrets:encrypt       # .env → .env.enc
npm run secrets:decrypt       # .env.enc → .env
npm run secrets:encrypt:dev   # .env.dev → .env.dev.enc
npm run secrets:decrypt:dev   # .env.dev.enc → .env.dev`

const backupCode = `# Manual backup
npm run tool:backup

# Backups are stored at:
# s3://{bucket}/{BACKUP_S3_PREFIX}{timestamp}/underlay.sql.gz`

export default function DocsSelfHost() {
  return (
    <DocsLayout title="Self-Hosting">
      <p>
        Underlay is designed to be self-hosted. You need three things: a Node.js runtime, a
        PostgreSQL database, and S3-compatible object storage.
      </p>

      <h2>Requirements</h2>
      <ul>
        <li>
          <strong>Node.js</strong> ≥ 22.12
        </li>
        <li>
          <strong>PostgreSQL</strong> 16+
        </li>
        <li>
          <strong>S3-compatible storage</strong> — AWS S3, MinIO, Cloudflare R2, etc.
        </li>
        <li>
          <strong>Docker</strong> (recommended) — or run directly with Node
        </li>
      </ul>

      <h2>Quick start with Docker</h2>
      <p>Clone the repo and run:</p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{devShCode}</code>
      </pre>
      <p>
        This starts Postgres, MinIO (S3), and the Underlay app in development mode. The dev script
        auto-creates a <code>.env.dev</code> from defaults if one doesn't exist.
      </p>

      <h2>Environment variables</h2>
      <table>
        <tbody>
          <tr>
            <td>
              <code>DATABASE_URL</code>
            </td>
            <td>PostgreSQL connection string</td>
          </tr>
          <tr>
            <td>
              <code>SESSION_SECRET</code>
            </td>
            <td>Secret for signing session cookies</td>
          </tr>
          <tr>
            <td>
              <code>PORT</code>
            </td>
            <td>Server port (default: 3000)</td>
          </tr>
          <tr>
            <td>
              <code>S3_BUCKET</code>
            </td>
            <td>S3 bucket name</td>
          </tr>
          <tr>
            <td>
              <code>S3_REGION</code>
            </td>
            <td>S3 region</td>
          </tr>
          <tr>
            <td>
              <code>S3_ENDPOINT</code>
            </td>
            <td>S3 endpoint URL (for MinIO, R2, etc.)</td>
          </tr>
          <tr>
            <td>
              <code>S3_ACCESS_KEY</code>
            </td>
            <td>S3 access key</td>
          </tr>
          <tr>
            <td>
              <code>S3_SECRET_KEY</code>
            </td>
            <td>S3 secret key</td>
          </tr>
          <tr>
            <td>
              <code>BACKUP_S3_PREFIX</code>
            </td>
            <td>S3 key prefix for database backups</td>
          </tr>
        </tbody>
      </table>

      <h2>Production deployment</h2>
      <p>The recommended production setup:</p>
      <ol>
        <li>
          Build the Docker image: <code>docker build -t underlay .</code>
        </li>
        <li>
          Create a <code>.env</code> with production values (or use SOPS encryption)
        </li>
        <li>
          Run with <code>docker compose up -d</code>
        </li>
      </ol>
      <p>
        The production <code>docker-compose.yml</code> includes:
      </p>
      <ul>
        <li>
          <strong>postgres</strong> — PostgreSQL 16 with a named volume
        </li>
        <li>
          <strong>app</strong> — Runs migrations, then starts the Hono server
        </li>
        <li>
          <strong>cron</strong> — Scheduled tasks (database backups)
        </li>
      </ul>

      <h2>Secrets management</h2>
      <p>
        We use <a href="https://github.com/getsops/sops">SOPS</a> with{' '}
        <a href="https://github.com/FiloSottile/age">age</a> encryption. Encrypted{' '}
        <code>.env.enc</code> files are committed to the repo; plaintext <code>.env</code> files are
        gitignored.
      </p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{secretsCode}</code>
      </pre>

      <h2>CI/CD</h2>
      <p>
        The included GitHub Actions workflow (<code>.github/workflows/deploy.yml</code>) handles the
        full pipeline:
      </p>
      <ol>
        <li>
          Push to <code>main</code>
        </li>
        <li>Build Docker image → push to GHCR</li>
        <li>
          SSH to server → pull image → decrypt secrets → <code>docker compose up</code>
        </li>
      </ol>
      <p>
        Required GitHub secrets: <code>SSH_PRIVATE_KEY</code>, <code>SSH_HOST</code>,{' '}
        <code>SSH_USER</code>, <code>GHCR_USER</code>, <code>GHCR_TOKEN</code>.
      </p>

      <h2>Backups</h2>
      <p>The cron container runs daily Postgres backups to S3:</p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{backupCode}</code>
      </pre>

      <h2>Reverse proxy</h2>
      <p>
        Put Caddy, nginx, or Cloudflare in front. The app exposes a single port (default 3000)
        serving both the API and SSR.
      </p>
    </DocsLayout>
  )
}
