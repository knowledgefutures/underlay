import { Link } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData } from '~/lib/ssr-data'

interface MirrorConfig {
  enabled: boolean
  nodeName: string
  upstream: string
}

export default function Home() {
  const mirrorConfig = useSSRData<MirrorConfig>('mirrorConfig')

  if (mirrorConfig?.enabled) {
    return (
      <BaseLayout>
        <div className="max-w-5xl mx-auto px-4">
          {/* Hero */}
          <section className="py-12 border-b border-rule">
            <div className="max-w-2xl">
              <h1 className="text-2xl font-semibold tracking-tight mb-3 font-sans">
                {mirrorConfig.nodeName}
              </h1>
              <p className="text-ink-muted text-sm leading-relaxed mb-2">
                This is a mirror of <Link to={mirrorConfig.upstream} className="underline hover:text-ink">{mirrorConfig.upstream.replace(/^https?:\/\//, '')}</Link>.
                It maintains a verified copy of all public collections for long-term preservation and local access.
              </p>
              <p className="text-ink-muted text-sm leading-relaxed mb-6">
                Every version, record, and file is content-addressed and hash-verified against the upstream source.
                If the primary server becomes unavailable, this mirror serves as an independent, complete archive.
              </p>
              <div className="flex gap-3">
                <Link to="/explore"
                  className="inline-block bg-ink text-parchment visited:text-parchment px-4 py-2 text-sm font-medium hover:bg-ink-light transition-colors"
                >
                  Explore collections
                </Link>
                <Link to="/schemas"
                  className="inline-block border border-ink px-4 py-2 text-sm font-medium hover:bg-parchment-dark transition-colors visited:text-ink"
                >
                  Browse schemas
                </Link>
              </div>
            </div>
          </section>

          {/* What this is */}
          <section className="py-8 border-b border-rule">
            <h2 className="text-xs uppercase tracking-widest text-ink-muted mb-5 font-semibold">What is this?</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
              <div>
                <h3 className="font-semibold mb-1 font-sans">A preservation mirror</h3>
                <p className="text-ink-muted">
                  This server replicates public collections from the canonical Underlay instance.
                  Each copy is cryptographically verified — tamper-evident by design.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-1 font-sans">Independent infrastructure</h3>
                <p className="text-ink-muted">
                  Running on separate hardware with its own database and storage.
                  No single point of failure — if the upstream goes down, the data persists here.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-1 font-sans">Open and browsable</h3>
                <p className="text-ink-muted">
                  Browse any collection, inspect any schema, view any record.
                  The same API works here as on the primary server.
                </p>
              </div>
            </div>
          </section>

          {/* Bottom */}
          <section className="py-8">
            <div className="flex gap-8 text-sm">
              <div>
                <h3 className="font-semibold mb-1 font-sans">Powered by Underlay</h3>
                <p className="text-ink-muted">
                  Underlay is open-source infrastructure for structured knowledge preservation.
                  Anyone can run a mirror — same software, different server.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-1 font-sans">Built by Knowledge Futures</h3>
                <p className="text-ink-muted">A 501(c)(3) nonprofit building open infrastructure for knowledge sharing.</p>
              </div>
            </div>
          </section>
        </div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout>
      <div className="max-w-5xl mx-auto px-4">
        {/* Hero */}
        <section className="py-12 border-b border-rule">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-semibold tracking-tight mb-3 font-sans">
              A public registry for structured knowledge.
            </h1>
            <p className="text-ink-muted text-sm leading-relaxed mb-6">
              Apps publish versioned snapshots of their data to Underlay.
              Each version is self-describing: a JSON Schema, flat records, content-addressed files.
              The structure is the infrastructure.
            </p>
            <div className="flex gap-3">
              <Link to="/docs"
                className="inline-block bg-ink text-parchment visited:text-parchment px-4 py-2 text-sm font-medium hover:bg-ink-light transition-colors"
              >
                Read the docs
              </Link>
              <Link to="/explore"
                className="inline-block border border-ink px-4 py-2 text-sm font-medium hover:bg-parchment-dark transition-colors visited:text-ink"
              >
                Explore collections
              </Link>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="py-8 border-b border-rule">
          <h2 className="text-xs uppercase tracking-widest text-ink-muted mb-5 font-semibold">How it works</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
            <div>
              <h3 className="font-semibold mb-1 font-sans">1. Push</h3>
              <p className="text-ink-muted">
                Your app serializes its current state and pushes a versioned snapshot to Underlay over HTTPS.
                A cron job, a webhook, or a button.
              </p>
            </div>
            <div>
              <h3 className="font-semibold mb-1 font-sans">2. Store</h3>
              <p className="text-ink-muted">
                Underlay validates records against the JSON Schema, deduplicates files by hash, and stores the version immutably.
              </p>
            </div>
            <div>
              <h3 className="font-semibold mb-1 font-sans">3. Browse</h3>
              <p className="text-ink-muted">
                Anyone can browse public collections, view any version, diff between versions, and export full archives.
              </p>
            </div>
          </div>
        </section>

        {/* Concepts */}
        <section className="py-8 border-b border-rule">
          <h2 className="text-xs uppercase tracking-widest text-ink-muted mb-5 font-semibold">Core concepts</h2>
          <div className="space-y-3 text-sm">
            <div className="flex gap-3">
              <span className="text-ink-muted w-24 shrink-0 text-right">collection</span>
              <span>A named, versioned body of structured data plus its files. The unit of preservation.</span>
            </div>
            <div className="flex gap-3">
              <span className="text-ink-muted w-24 shrink-0 text-right">version</span>
              <span>An immutable snapshot: JSON Schema + records + files + metadata.</span>
            </div>
            <div className="flex gap-3">
              <span className="text-ink-muted w-24 shrink-0 text-right">record</span>
              <span>A flat JSON object. One entity, one row. Relationships via ID references.</span>
            </div>
            <div className="flex gap-3">
              <span className="text-ink-muted w-24 shrink-0 text-right">file</span>
              <span>A binary blob, content-addressed by SHA-256. Stored once, referenced everywhere.</span>
            </div>
          </div>
        </section>

        {/* API preview */}
        <section className="py-8 border-b border-rule">
          <h2 className="text-xs uppercase tracking-widest text-ink-muted mb-5 font-semibold">The API</h2>
          <p className="text-sm text-ink-muted mb-4">~13 endpoints. Each one does one thing.</p>
          <pre className="bg-ink text-parchment p-4 text-xs overflow-x-auto leading-relaxed"><code>{`POST   /accounts/:owner/collections            # create a collection
GET    /collections/:owner/:slug               # collection metadata
POST   /collections/:owner/:slug/versions      # push a version
GET    /collections/:owner/:slug/versions/:n   # read a version
GET    .../versions/:n/records                 # browse records
GET    .../versions/:n/diff?from=:m            # diff versions
PUT    /collections/:owner/:slug/files/:hash   # upload a file
GET    /collections/:owner/:slug/files/:hash   # download a file
GET    /collections/:owner/:slug/export        # full archive`}</code></pre>
        </section>

        {/* Bottom */}
        <section className="py-8">
          <div className="flex gap-8 text-sm">
            <div>
              <h3 className="font-semibold mb-1 font-sans">Open source</h3>
              <p className="text-ink-muted">MIT licensed. Run your own instance or push to the canonical host at underlay.org.</p>
            </div>
            <div>
              <h3 className="font-semibold mb-1 font-sans">Built by Knowledge Futures</h3>
              <p className="text-ink-muted">A 501(c)(3) nonprofit building open infrastructure for knowledge sharing.</p>
            </div>
          </div>
        </section>
      </div>
    </BaseLayout>
  )
}
