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
        <div className="mx-auto max-w-5xl px-4">
          {/* Hero */}
          <section className="border-rule border-b py-12">
            <div className="max-w-2xl">
              <h1 className="mb-3 font-sans text-2xl font-semibold tracking-tight">
                {mirrorConfig.nodeName}
              </h1>
              <p className="text-ink-muted mb-2 text-sm leading-relaxed">
                This is a mirror of{' '}
                <Link to={mirrorConfig.upstream} className="hover:text-ink underline">
                  {mirrorConfig.upstream.replace(/^https?:\/\//, '')}
                </Link>
                . It maintains a verified copy of all public collections for long-term preservation
                and local access.
              </p>
              <p className="text-ink-muted mb-6 text-sm leading-relaxed">
                Every version, record, and file is content-addressed and hash-verified against the
                upstream source. If the primary server becomes unavailable, this mirror serves as an
                independent, complete archive.
              </p>
              <div className="flex gap-3">
                <Link
                  to="/explore"
                  className="bg-ink text-parchment visited:text-parchment hover:bg-ink-light inline-block px-4 py-2 text-sm font-medium transition-colors"
                >
                  Explore collections
                </Link>
                <Link
                  to="/schemas"
                  className="border-ink hover:bg-parchment-dark visited:text-ink inline-block border px-4 py-2 text-sm font-medium transition-colors"
                >
                  Browse schemas
                </Link>
              </div>
            </div>
          </section>

          {/* What this is */}
          <section className="border-rule border-b py-8">
            <h2 className="text-ink-muted mb-5 text-xs font-semibold tracking-widest uppercase">
              What is this?
            </h2>
            <div className="grid grid-cols-1 gap-6 text-sm md:grid-cols-3">
              <div>
                <h3 className="mb-1 font-sans font-semibold">A preservation mirror</h3>
                <p className="text-ink-muted">
                  This server replicates public collections from the canonical Underlay instance.
                  Each copy is cryptographically verified — tamper-evident by design.
                </p>
              </div>
              <div>
                <h3 className="mb-1 font-sans font-semibold">Independent infrastructure</h3>
                <p className="text-ink-muted">
                  Running on separate hardware with its own database and storage. No single point of
                  failure — if the upstream goes down, the data persists here.
                </p>
              </div>
              <div>
                <h3 className="mb-1 font-sans font-semibold">Open and browsable</h3>
                <p className="text-ink-muted">
                  Browse any collection, inspect any schema, view any record. The same API works
                  here as on the primary server.
                </p>
              </div>
            </div>
          </section>

          {/* Bottom */}
          <section className="py-8">
            <div className="flex gap-8 text-sm">
              <div>
                <h3 className="mb-1 font-sans font-semibold">Powered by Underlay</h3>
                <p className="text-ink-muted">
                  Underlay is open-source infrastructure for structured knowledge preservation.
                  Anyone can run a mirror — same software, different server.
                </p>
              </div>
              <div>
                <h3 className="mb-1 font-sans font-semibold">Built by Knowledge Futures</h3>
                <p className="text-ink-muted">
                  A 501(c)(3) public charity building open infrastructure for knowledge sharing.
                </p>
              </div>
            </div>
          </section>
        </div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4">
        {/* Hero */}
        <section className="border-rule border-b py-12">
          <div className="max-w-2xl">
            <h1 className="mb-3 font-sans text-2xl font-semibold tracking-tight">
              A public registry for structured knowledge.
            </h1>
            <p className="text-ink-muted mb-6 text-sm leading-relaxed">
              Apps publish versioned snapshots of their data to Underlay. Each version is
              self-describing: a JSON Schema, flat records, content-addressed files. The structure
              is the infrastructure.
            </p>
            <div className="flex gap-3">
              <Link
                to="/docs"
                className="bg-ink text-parchment visited:text-parchment hover:bg-ink-light inline-block px-4 py-2 text-sm font-medium transition-colors"
              >
                Read the docs
              </Link>
              <Link
                to="/explore"
                className="border-ink hover:bg-parchment-dark visited:text-ink inline-block border px-4 py-2 text-sm font-medium transition-colors"
              >
                Explore collections
              </Link>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-rule border-b py-8">
          <h2 className="text-ink-muted mb-5 text-xs font-semibold tracking-widest uppercase">
            How it works
          </h2>
          <div className="grid grid-cols-1 gap-6 text-sm md:grid-cols-3">
            <div>
              <h3 className="mb-1 font-sans font-semibold">1. Push</h3>
              <p className="text-ink-muted">
                Your app serializes its current state and pushes a versioned snapshot to Underlay
                over HTTPS. A cron job, a webhook, or a button.
              </p>
            </div>
            <div>
              <h3 className="mb-1 font-sans font-semibold">2. Store</h3>
              <p className="text-ink-muted">
                Underlay validates records against the JSON Schema, deduplicates files by hash, and
                stores the version immutably.
              </p>
            </div>
            <div>
              <h3 className="mb-1 font-sans font-semibold">3. Browse</h3>
              <p className="text-ink-muted">
                Anyone can browse public collections, view any version, diff between versions, and
                export full archives.
              </p>
            </div>
          </div>
        </section>

        {/* Concepts */}
        <section className="border-rule border-b py-8">
          <h2 className="text-ink-muted mb-5 text-xs font-semibold tracking-widest uppercase">
            Core concepts
          </h2>
          <div className="space-y-3 text-sm">
            <div className="flex gap-3">
              <span className="text-ink-muted w-24 shrink-0 text-right">collection</span>
              <span>
                A named, versioned body of structured data plus its files. The unit of preservation.
              </span>
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
              <span>
                A binary blob, content-addressed by SHA-256. Stored once, referenced everywhere.
              </span>
            </div>
          </div>
        </section>

        {/* API preview */}
        <section className="border-rule border-b py-8">
          <h2 className="text-ink-muted mb-5 text-xs font-semibold tracking-widest uppercase">
            The API
          </h2>
          <p className="text-ink-muted mb-4 text-sm">~13 endpoints. Each one does one thing.</p>
          <pre className="bg-ink text-parchment overflow-x-auto p-4 text-xs leading-relaxed">
            <code>{`POST   /accounts/:owner/collections            # create a collection
GET    /collections/:owner/:slug               # collection metadata
POST   /collections/:owner/:slug/versions      # push a version
GET    /collections/:owner/:slug/versions/:n   # read a version
GET    .../versions/:n/records                 # browse records
GET    .../versions/:n/diff?from=:m            # diff versions
PUT    /collections/:owner/:slug/files/:hash   # upload a file
GET    /collections/:owner/:slug/files/:hash   # download a file
GET    /collections/:owner/:slug/export        # full archive`}</code>
          </pre>
        </section>

        {/* Bottom */}
        <section className="py-8">
          <div className="flex gap-8 text-sm">
            <div>
              <h3 className="mb-1 font-sans font-semibold">Open source</h3>
              <p className="text-ink-muted">
                MIT licensed. Run your own instance or push to the canonical host at underlay.org.
              </p>
            </div>
            <div>
              <h3 className="mb-1 font-sans font-semibold">Built by Knowledge Futures</h3>
              <p className="text-ink-muted">
                A 501(c)(3) public charity building open infrastructure for knowledge sharing.
              </p>
            </div>
          </div>
        </section>
      </div>
    </BaseLayout>
  )
}
