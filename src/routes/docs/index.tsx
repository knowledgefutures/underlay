import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

export default function Docs() {
  return (
    <DocsLayout title="Documentation">
      <p>
        Underlay has a small API surface. These docs are the SDK. Read them, point your LLM at them,
        or just curl the endpoints. For a machine-readable version, see{' '}
        <Link to="/llms.txt" className="text-link underline">
          llms.txt
        </Link>
        .
      </p>

      <nav className="space-y-5 text-sm">
        <section>
          <h2>Getting started</h2>
          <ul className="space-y-1 pl-0.5">
            <li>
              <Link to="/docs/concepts" className="text-link underline">
                Concepts
              </Link>{' '}
              <span className="text-ink-muted text-xs">
                — Collections, versions, records, files
              </span>
            </li>
            <li>
              <Link to="/docs/quickstart" className="text-link underline">
                Quickstart
              </Link>{' '}
              <span className="text-ink-muted text-xs">— Push your first version in 5 minutes</span>
            </li>
            <li>
              <Link to="/docs/integration" className="text-link underline">
                Integration Guide
              </Link>{' '}
              <span className="text-ink-muted text-xs">— Push data from any app, no SDK</span>
            </li>
          </ul>
        </section>

        <section>
          <h2>API reference</h2>
          <ul className="space-y-1 pl-0.5">
            <li>
              <Link to="/docs/api" className="text-link underline">
                Overview
              </Link>{' '}
              <span className="text-ink-muted text-xs">— Auth, rate limits, error handling</span>
            </li>
            <li>
              <Link to="/docs/api/accounts" className="text-link underline">
                Accounts
              </Link>{' '}
              <span className="text-ink-muted text-xs">— Signup, login, API keys</span>
            </li>
            <li>
              <Link to="/docs/api/collections" className="text-link underline">
                Collections
              </Link>{' '}
              <span className="text-ink-muted text-xs">— Create, list, update, delete</span>
            </li>
            <li>
              <Link to="/docs/api/versions" className="text-link underline">
                Versions
              </Link>{' '}
              <span className="text-ink-muted text-xs">— Push snapshots, browse history, diff</span>
            </li>
            <li>
              <Link to="/docs/api/files" className="text-link underline">
                Files
              </Link>{' '}
              <span className="text-ink-muted text-xs">
                — Upload and download content-addressed files
              </span>
            </li>
          </ul>
        </section>

        <section>
          <h2>Infrastructure</h2>
          <ul className="space-y-1 pl-0.5">
            <li>
              <Link to="/docs/self-host" className="text-link underline">
                Self-hosting
              </Link>{' '}
              <span className="text-ink-muted text-xs">— Docker, Postgres, S3</span>
            </li>
          </ul>
        </section>

        <section>
          <h2>Specification</h2>
          <ul className="space-y-1 pl-0.5">
            <li>
              <Link to="/protocol" className="text-link underline">
                Protocol
              </Link>{' '}
              <span className="text-ink-muted text-xs">
                — Content-addressed data model, hashing spec, negotiate push/pull
              </span>
            </li>
          </ul>
        </section>
      </nav>
    </DocsLayout>
  )
}
