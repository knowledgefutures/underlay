import DocsLayout from '~/components/DocsLayout'

export default function Docs() {
  return (
    <DocsLayout title="Documentation">
      <p>Underlay has a small API surface. These docs are the SDK. Read them, point your LLM at them, or just curl the endpoints. For a machine-readable version, see <a href="/.well-known/ai.txt" className="text-link underline">ai.txt</a>.</p>

      <nav className="space-y-5 text-sm">
        <section>
          <h2>Getting started</h2>
          <ul className="space-y-1 pl-0.5">
            <li><a href="/docs/concepts" className="text-link underline">Concepts</a> <span className="text-ink-muted text-xs">— Collections, versions, records, files</span></li>
            <li><a href="/docs/quickstart" className="text-link underline">Quickstart</a> <span className="text-ink-muted text-xs">— Push your first version in 5 minutes</span></li>
            <li><a href="/docs/integration" className="text-link underline">Integration Guide</a> <span className="text-ink-muted text-xs">— Push data from any app, no SDK</span></li>
          </ul>
        </section>

        <section>
          <h2>API reference</h2>
          <ul className="space-y-1 pl-0.5">
            <li><a href="/docs/api" className="text-link underline">Overview</a> <span className="text-ink-muted text-xs">— Auth, rate limits, error handling</span></li>
            <li><a href="/docs/api/accounts" className="text-link underline">Accounts</a> <span className="text-ink-muted text-xs">— Signup, login, API keys</span></li>
            <li><a href="/docs/api/collections" className="text-link underline">Collections</a> <span className="text-ink-muted text-xs">— Create, list, update, delete</span></li>
            <li><a href="/docs/api/versions" className="text-link underline">Versions</a> <span className="text-ink-muted text-xs">— Push snapshots, browse history, diff</span></li>
            <li><a href="/docs/api/files" className="text-link underline">Files</a> <span className="text-ink-muted text-xs">— Upload and download content-addressed files</span></li>
          </ul>
        </section>

        <section>
          <h2>Infrastructure</h2>
          <ul className="space-y-1 pl-0.5">
            <li><a href="/docs/self-host" className="text-link underline">Self-hosting</a> <span className="text-ink-muted text-xs">— Docker, Postgres, S3</span></li>
          </ul>
        </section>
      </nav>
    </DocsLayout>
  )
}
