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
                  className="bg-ink text-parchment visited:text-parchment hover:bg-ink-light inline-block rounded px-4 py-2 text-sm font-medium transition-colors"
                >
                  Explore collections
                </Link>
                <Link
                  to="/schemas"
                  className="border-ink hover:bg-parchment-dark visited:text-ink inline-block rounded border px-4 py-2 text-sm font-medium transition-colors"
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
                  A 501(c)(3) nonprofit building open infrastructure for knowledge sharing.
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
        <section className="py-16">
          <div className="max-w-2xl">
            <h1 className="mb-4 font-sans text-3xl font-semibold tracking-tight">
              Knowledge that lasts.
            </h1>
            <p className="text-ink-light mb-8 text-base leading-relaxed">
              Underlay is a public registry where organizations publish versioned snapshots of their
              structured data — making it permanently discoverable, verifiable, and citable.
              Research datasets, publication archives, open knowledge: published once, preserved
              indefinitely.
            </p>
            <div className="flex gap-3">
              <Link
                to="/explore"
                className="bg-ink text-parchment visited:text-parchment hover:bg-ink-light inline-block rounded px-5 py-2.5 text-sm font-medium transition-colors"
              >
                Explore collections
              </Link>
              <Link
                to="/docs/quickstart"
                className="border-ink hover:bg-parchment-dark visited:text-ink inline-block rounded border px-5 py-2.5 text-sm font-medium transition-colors"
              >
                Start publishing
              </Link>
            </div>
          </div>
        </section>

        {/* Value propositions */}
        <section className="border-rule border-t py-12">
          <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
            <div>
              <h3 className="mb-2 font-sans text-base font-semibold">Permanent</h3>
              <p className="text-ink-muted text-sm leading-relaxed">
                Every version of your data is stored immutably. Research doesn't disappear when a
                project ends or a server goes down. Once published, it's preserved.
              </p>
            </div>
            <div>
              <h3 className="mb-2 font-sans text-base font-semibold">Verifiable</h3>
              <p className="text-ink-muted text-sm leading-relaxed">
                Content-addressed storage means anyone can confirm that data hasn't been altered.
                Cryptographic hashes at every level make tampering evident and trust auditable.
              </p>
            </div>
            <div>
              <h3 className="mb-2 font-sans text-base font-semibold">Discoverable</h3>
              <p className="text-ink-muted text-sm leading-relaxed">
                Structured data with shared schemas across collections. Browse, search, and export —
                every dataset is openly accessible through both the web and a REST API.
              </p>
            </div>
          </div>
        </section>

        {/* Who it's for */}
        <section className="border-rule border-t py-12">
          <h2 className="text-ink-muted mb-6 text-xs font-semibold tracking-widest uppercase">
            Built for
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="border-rule rounded border p-5">
              <h3 className="mb-1 font-sans font-semibold">Research institutions</h3>
              <p className="text-ink-muted text-sm leading-relaxed">
                Preserve datasets beyond the life of a grant. Publish versioned snapshots that are
                citable and independently verifiable.
              </p>
            </div>
            <div className="border-rule rounded border p-5">
              <h3 className="mb-1 font-sans font-semibold">Academic publishers</h3>
              <p className="text-ink-muted text-sm leading-relaxed">
                Archive publication metadata, review data, and supplementary materials in a format
                that's structured, searchable, and open.
              </p>
            </div>
            <div className="border-rule rounded border p-5">
              <h3 className="mb-1 font-sans font-semibold">Open data organizations</h3>
              <p className="text-ink-muted text-sm leading-relaxed">
                Share curated datasets with the public. Underlay handles versioning, integrity, and
                access — so you can focus on the data itself.
              </p>
            </div>
            <div className="border-rule rounded border p-5">
              <h3 className="mb-1 font-sans font-semibold">Developers</h3>
              <p className="text-ink-muted text-sm leading-relaxed">
                Build on open knowledge. Pull snapshots via API, integrate with existing workflows,
                or run your own Underlay instance.
              </p>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-rule border-t py-12">
          <h2 className="text-ink-muted mb-6 text-xs font-semibold tracking-widest uppercase">
            How it works
          </h2>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
            <div>
              <div className="text-ink-muted mb-2 font-mono text-xs">01</div>
              <h3 className="mb-1 font-sans font-semibold">Publish</h3>
              <p className="text-ink-muted text-sm leading-relaxed">
                Push structured data via a simple REST API. Define your schema, add records and
                files, and create a versioned snapshot.
              </p>
            </div>
            <div>
              <div className="text-ink-muted mb-2 font-mono text-xs">02</div>
              <h3 className="mb-1 font-sans font-semibold">Preserve</h3>
              <p className="text-ink-muted text-sm leading-relaxed">
                Each version is validated, deduplicated, and stored immutably. Files are
                content-addressed. Every byte is accounted for.
              </p>
            </div>
            <div>
              <div className="text-ink-muted mb-2 font-mono text-xs">03</div>
              <h3 className="mb-1 font-sans font-semibold">Discover</h3>
              <p className="text-ink-muted text-sm leading-relaxed">
                Anyone can browse collections, inspect schemas, view diffs between versions, and
                export full archives. The data is the interface.
              </p>
            </div>
          </div>
        </section>

        {/* Bottom */}
        <section className="border-rule border-t py-10">
          <div className="flex flex-col gap-8 text-sm md:flex-row md:gap-16">
            <div>
              <h3 className="mb-1 font-sans font-semibold">Open source</h3>
              <p className="text-ink-muted leading-relaxed">
                MIT licensed. Run your own instance, contribute, or push data to the canonical host
                at underlay.org.
              </p>
            </div>
            <div>
              <h3 className="mb-1 font-sans font-semibold">Built by Knowledge Futures</h3>
              <p className="text-ink-muted leading-relaxed">
                A 501(c)(3) nonprofit building open infrastructure for the production, curation, and
                preservation of knowledge.
              </p>
            </div>
          </div>
        </section>
      </div>
    </BaseLayout>
  )
}
