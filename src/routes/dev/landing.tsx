import { useState } from 'react'
import { Link } from 'react-router'

function Nav({ current, onChange }: { current: number; onChange: (n: number) => void }) {
  return (
    <div className="bg-ink text-parchment fixed top-0 right-0 left-0 z-50 flex items-center gap-4 px-6 py-2 text-xs">
      <span className="font-mono opacity-60">Landing variants</span>
      {[1, 2, 3, 4].map((n) => (
        <button
          key={n}
          onClick={() => onChange(n)}
          className={`cursor-pointer rounded px-2 py-0.5 font-mono transition-colors ${current === n ? 'bg-parchment text-ink' : 'hover:bg-ink-light'}`}
        >
          {n}
        </button>
      ))}
    </div>
  )
}

function Footer() {
  return (
    <footer className="border-rule border-t">
      <div className="text-ink-muted mx-auto flex max-w-5xl items-center justify-between px-4 py-6 text-xs">
        <div className="flex items-center gap-1.5">
          <span>&copy; {new Date().getFullYear()}</span>
          <a href="https://www.knowledgefutures.org" className="hover:text-ink underline">
            Knowledge Futures
          </a>
        </div>
        <div className="flex items-center gap-4">
          <a href="https://github.com/knowledgefutures/underlay" className="hover:text-ink">
            GitHub
          </a>
          <span className="text-rule">&middot;</span>
          <span className="font-mono">v0.1.0</span>
        </div>
      </div>
    </footer>
  )
}

function Header({ inverted }: { inverted?: boolean }) {
  const bg = inverted ? 'bg-ink text-parchment' : ''
  const linkClass = inverted ? 'opacity-60 hover:opacity-100' : 'text-ink-muted hover:text-ink'
  return (
    <header className={`${bg} ${inverted ? '' : 'border-rule border-b'}`}>
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <Link to="/" className="flex items-center gap-2.5">
          <img
            src="https://docs.underlay.org/logoLight.svg"
            alt="Underlay"
            className={`h-6 ${inverted ? 'invert' : ''}`}
          />
          <span className="text-base font-semibold tracking-tight">Underlay</span>
        </Link>
        <div className={`flex items-center gap-5 text-sm`}>
          <Link to="/explore" className={linkClass}>
            Explore
          </Link>
          <Link to="/schemas" className={linkClass}>
            Schemas
          </Link>
          <Link to="/docs" className={linkClass}>
            Docs
          </Link>
          <a href="/login" className={linkClass}>
            Log in
          </a>
        </div>
      </nav>
    </header>
  )
}

const COLLECTIONS = [
  {
    owner: 'crossref',
    slug: 'metadata-2024',
    records: '142M',
    versions: 12,
    schema: 'CrossrefWork',
    desc: 'Scholarly metadata from 158,000+ publishers',
  },
  {
    owner: 'orcid',
    slug: 'public-data',
    records: '19M',
    versions: 8,
    schema: 'OrcidRecord',
    desc: 'Public researcher profiles and affiliations',
  },
  {
    owner: 'datacite',
    slug: 'doi-registry',
    records: '51M',
    versions: 24,
    schema: 'DataCiteMetadata',
    desc: 'DOI registrations for research data and outputs',
  },
  {
    owner: 'openalex',
    slug: 'works-snapshot',
    records: '248M',
    versions: 6,
    schema: 'OpenAlexWork',
    desc: 'Open catalog of scholarly papers, authors, institutions',
  },
  {
    owner: 'ror',
    slug: 'registry',
    records: '106K',
    versions: 31,
    schema: 'RorOrganization',
    desc: 'Research Organization Registry — persistent identifiers for institutions',
  },
]

function CollectionRow({ c }: { c: (typeof COLLECTIONS)[0] }) {
  return (
    <Link
      to={`/${c.owner}/${c.slug}`}
      className="border-rule hover:bg-parchment-dark flex items-center border-b py-3 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-link text-sm font-medium">{c.owner}</span>
          <span className="text-ink-muted text-xs">/</span>
          <span className="text-ink text-sm font-medium">{c.slug}</span>
        </div>
        <p className="text-ink-muted mt-0.5 truncate text-xs">{c.desc}</p>
      </div>
      <div className="text-ink-muted flex items-center gap-6 text-xs">
        <span className="w-16 text-right font-mono">{c.records}</span>
        <span className="text-rule w-12 text-right">v{c.versions}</span>
      </div>
    </Link>
  )
}

// ─── Variant 1: Protocol ─────────────────────────────────────────────────────
// Leads with the blog's core thesis. Shows the contract, then the CLI,
// then the registry. Dense and specific.
function V1() {
  return (
    <div className="min-h-screen font-sans">
      <Header />

      <section className="border-rule border-b py-16">
        <div className="mx-auto max-w-5xl px-4">
          <div className="grid grid-cols-[1fr_340px] items-start gap-16">
            <div>
              <h1 className="text-ink mb-5 text-3xl leading-snug font-normal tracking-tight">
                A protocol for giving structured data a permanent address
              </h1>
              <p className="text-ink-muted mb-4 text-sm leading-relaxed">
                Push JSON records and a JSON Schema. Get back a versioned, content-addressed
                snapshot you can point to forever. Schemas are first-class objects: inspectable,
                comparable, and alignable across independently authored datasets.
              </p>
              <p className="text-ink-muted mb-8 text-sm leading-relaxed">
                That is the whole primitive. Everything else — querying, transforming,
                collaborating, aligning across datasets — is built on top by agents and people, not
                by the infrastructure.
              </p>
              <div className="flex gap-3">
                <Link
                  to="/explore"
                  className="bg-ink text-parchment hover:bg-ink-light px-5 py-2.5 text-sm font-medium transition-colors"
                >
                  Explore the registry
                </Link>
                <Link
                  to="/docs/quickstart"
                  className="border-rule hover:bg-parchment-dark border px-5 py-2.5 text-sm font-medium transition-colors"
                >
                  Start publishing
                </Link>
              </div>
            </div>

            {/* The core contract */}
            <div className="border-rule border bg-white/30">
              <div className="border-rule border-b px-5 py-2.5">
                <span className="text-ink-muted font-mono text-[10px] tracking-widest uppercase">
                  The contract
                </span>
              </div>
              <div className="space-y-0 text-sm">
                <div className="border-rule flex gap-3 border-b px-5 py-2.5">
                  <span className="text-rule font-mono text-xs">1</span>
                  <span className="text-ink-muted text-xs">
                    Push JSON records conforming to a JSON Schema.
                  </span>
                </div>
                <div className="border-rule flex gap-3 border-b px-5 py-2.5">
                  <span className="text-rule font-mono text-xs">2</span>
                  <span className="text-ink-muted text-xs">
                    Underlay stores them as an immutable, content-addressed version.
                  </span>
                </div>
                <div className="border-rule flex gap-3 border-b px-5 py-2.5">
                  <span className="text-rule font-mono text-xs">3</span>
                  <span className="text-ink-muted text-xs">
                    Each version gets a semver: schema changed (major), records changed (minor).
                  </span>
                </div>
                <div className="border-rule flex gap-3 border-b px-5 py-2.5">
                  <span className="text-rule font-mono text-xs">4</span>
                  <span className="text-ink-muted text-xs">
                    Version v2.3.0 will always return exactly the same records and schema.
                  </span>
                </div>
                <div className="flex gap-3 px-5 py-2.5">
                  <span className="text-rule font-mono text-xs">5</span>
                  <span className="text-ink-muted text-xs">
                    Diff any two versions to see what changed.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-parchment-dark py-10">
        <div className="mx-auto max-w-5xl px-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-ink-muted font-mono text-[11px] tracking-widest uppercase">
              In the registry
            </h2>
            <Link to="/explore" className="text-link text-xs hover:underline">
              View all &rarr;
            </Link>
          </div>
          <div className="border-rule border-t">
            {COLLECTIONS.map((c) => (
              <CollectionRow key={c.slug} c={c} />
            ))}
          </div>
        </div>
      </section>

      <section className="py-14">
        <div className="mx-auto max-w-5xl px-4">
          <h2 className="text-ink-muted mb-8 font-mono text-[11px] tracking-widest uppercase">
            How it compares
          </h2>
          <div className="grid grid-cols-3 gap-10 text-sm">
            <div>
              <h3 className="text-ink mb-2 font-semibold">GitHub versions code</h3>
              <p className="text-ink-muted leading-relaxed">
                Git diffs are line-oriented. Change one field in a JSON file and you get a line
                diff, not a semantic one. Git does not know what a "record" is.
              </p>
            </div>
            <div>
              <h3 className="text-ink mb-2 font-semibold">Hugging Face versions files</h3>
              <p className="text-ink-muted leading-relaxed">
                You version files, download the whole thing, process locally. No record-level API,
                no schema diffing, no "what changed since v1.2.0."
              </p>
            </div>
            <div>
              <h3 className="text-ink mb-2 font-semibold">Underlay versions knowledge</h3>
              <p className="text-ink-muted leading-relaxed">
                The typed record is the primitive. Record-level diffs, schemas you can inspect and
                compare, incremental pull. It knows what structure means.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-rule border-t py-10">
        <div className="text-ink-muted mx-auto max-w-5xl px-4 text-center text-xs">
          Open source &middot; MIT licensed &middot; Built by{' '}
          <a href="https://www.knowledgefutures.org" className="text-link hover:underline">
            Knowledge Futures
          </a>
          , a 501(c)(3) nonprofit
        </div>
      </section>
      <Footer />
    </div>
  )
}

// ─── Variant 2: Primitive ────────────────────────────────────────────────────
// Dark hero emphasizing "the simplicity is the point". Below: CLI workflow
// showing how it actually works. Then the registry table.
function V2() {
  return (
    <div className="min-h-screen font-sans">
      <section className="bg-ink text-parchment">
        <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2.5">
            <img
              src="https://docs.underlay.org/logoLight.svg"
              alt="Underlay"
              className="h-6 invert"
            />
            <span className="text-base font-semibold tracking-tight">Underlay</span>
          </div>
          <div className="flex items-center gap-5 text-sm opacity-60">
            <Link to="/explore" className="hover:opacity-100">
              Explore
            </Link>
            <Link to="/schemas" className="hover:opacity-100">
              Schemas
            </Link>
            <Link to="/docs" className="hover:opacity-100">
              Docs
            </Link>
            <a href="/login" className="hover:opacity-100">
              Log in
            </a>
          </div>
        </nav>

        <div className="mx-auto max-w-5xl px-4 pt-16 pb-20">
          <h1 className="mb-6 max-w-2xl text-4xl leading-[1.15] font-extralight tracking-tight">
            Permanent addresses <br />
            for structured data
          </h1>
          <p className="mb-4 max-w-lg text-sm leading-relaxed opacity-60">
            Push records and a schema. Get back a versioned, content-addressed snapshot you can
            point to forever. An agent, an application, a scraper, a researcher — they all interact
            with the same primitive.
          </p>
          <p className="mb-10 max-w-lg text-sm leading-relaxed opacity-40">
            The intelligence lives in the actors, not the store.
          </p>
          <div className="flex gap-3">
            <Link
              to="/explore"
              className="bg-parchment text-ink hover:bg-parchment-dark px-5 py-2.5 text-sm font-medium transition-colors"
            >
              Explore the registry
            </Link>
            <Link
              to="/docs/quickstart"
              className="px-5 py-2.5 text-sm font-medium opacity-60 transition-opacity hover:opacity-100"
              style={{ border: '1px solid currentColor' }}
            >
              Read the docs
            </Link>
          </div>
        </div>
      </section>

      {/* CLI workflow */}
      <section className="py-14">
        <div className="mx-auto max-w-5xl px-4">
          <div className="grid grid-cols-[1fr_1fr] items-start gap-12">
            <div>
              <h2 className="text-ink-muted mb-6 font-mono text-[11px] tracking-widest uppercase">
                The workflow
              </h2>
              <div className="bg-ink text-parchment overflow-hidden font-mono text-[12px] leading-relaxed">
                <div className="border-b border-white/10 px-4 py-2 text-[10px] text-white/30">
                  terminal
                </div>
                <div className="space-y-1 px-4 py-4">
                  <div>
                    <span className="text-white/40">$</span> underlay init my-collection
                  </div>
                  <div>
                    <span className="text-white/40">$</span> underlay schema set schema.json
                  </div>
                  <div>
                    <span className="text-white/40">$</span> underlay add records.jsonl
                  </div>
                  <div>
                    <span className="text-white/40">$</span> underlay status
                  </div>
                  <div className="pl-2 text-white/40">
                    3,847 records staged · schema: AuthorRecord v1
                  </div>
                  <div className="mt-2">
                    <span className="text-white/40">$</span> underlay commit -m "initial load"
                  </div>
                  <div className="pl-2 text-white/40">v1.0.0 · sha256:a3f8c1...</div>
                  <div className="mt-2">
                    <span className="text-white/40">$</span> underlay push
                  </div>
                  <div className="pl-2 text-green-400/60">
                    published to underlay.org/my-org/my-collection
                  </div>
                </div>
              </div>
            </div>
            <div className="pt-10">
              <p className="text-ink-muted mb-4 text-sm leading-relaxed">
                Push what you have, in whatever structure you have it. The schemas make it legible.
                The models make it interoperable.
              </p>
              <p className="text-ink-muted mb-4 text-sm leading-relaxed">
                You don't need to agree on anything before contributing. Previous attempts at
                structured data sharing required agreement before contribution — a coordination
                problem that doesn't scale. LLMs change this: alignment happens after the fact, not
                before.
              </p>
              <p className="text-ink-muted text-sm leading-relaxed">
                Schemas are first-class, content-addressed objects. Two collections that
                independently define the same Author type produce the same schema hash. Alignment
                falls out of the data model automatically.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-parchment-dark py-10">
        <div className="mx-auto max-w-5xl px-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-ink-muted font-mono text-[11px] tracking-widest uppercase">
              In the registry
            </h2>
            <Link to="/explore" className="text-link text-xs hover:underline">
              View all &rarr;
            </Link>
          </div>
          <div className="border-rule border-t">
            {COLLECTIONS.map((c) => (
              <CollectionRow key={c.slug} c={c} />
            ))}
          </div>
        </div>
      </section>

      <section className="py-10">
        <div className="text-ink-muted mx-auto max-w-5xl px-4 text-center text-xs">
          Open source &middot; MIT licensed &middot; Built by{' '}
          <a href="https://www.knowledgefutures.org" className="text-link hover:underline">
            Knowledge Futures
          </a>
          , a 501(c)(3) nonprofit
        </div>
      </section>
      <Footer />
    </div>
  )
}

// ─── Variant 3: Specimen + Protocol ──────────────────────────────────────────
// Blog's language in the hero, specimen card showing a real collection,
// then the "how it compares" framing.
function V3() {
  return (
    <div className="min-h-screen font-sans">
      <Header />

      <section className="py-16">
        <div className="mx-auto max-w-5xl px-4">
          <div className="grid grid-cols-[1fr_400px] items-start gap-12">
            <div className="pt-2">
              <p className="text-ink-muted mb-4 font-mono text-[11px] tracking-widest uppercase">
                Permanently addressable structured data
              </p>
              <h1 className="text-ink mb-5 text-3xl leading-snug font-normal tracking-tight">
                Push records and a schema. <br />
                Get back a permanent address.
              </h1>
              <p className="text-ink-muted mb-4 text-sm leading-relaxed">
                Underlay does one thing: you give it records and a schema, it versions and preserves
                them, and anyone can pull a specific version and know exactly what they're getting.
              </p>
              <p className="text-ink-muted mb-8 text-sm leading-relaxed">
                The simplicity is the point. An agent, an application, a scraper, a researcher —
                they all interact with the same primitive. Push records in, pull records out, trust
                the versions.
              </p>
              <div className="flex gap-3">
                <Link
                  to="/explore"
                  className="bg-ink text-parchment hover:bg-ink-light px-5 py-2.5 text-sm font-medium transition-colors"
                >
                  Explore the registry
                </Link>
                <Link
                  to="/docs/quickstart"
                  className="border-rule hover:bg-parchment-dark border px-5 py-2.5 text-sm font-medium transition-colors"
                >
                  Start publishing
                </Link>
              </div>
            </div>

            {/* Specimen card */}
            <div className="border-rule border bg-white/30">
              <div className="border-rule border-b px-5 py-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-link font-medium">crossref</span>
                  <span className="text-ink-muted">/</span>
                  <span className="text-ink font-medium">metadata-2024</span>
                </div>
                <p className="text-ink-muted mt-1 text-xs">
                  Scholarly metadata from 158,000+ publishers
                </p>
              </div>
              <div className="space-y-0">
                <div className="border-rule flex justify-between border-b px-5 py-2 text-xs">
                  <span className="text-ink-muted">Version</span>
                  <span className="text-ink font-mono">v12 &middot; 4.12.0</span>
                </div>
                <div className="border-rule flex justify-between border-b px-5 py-2 text-xs">
                  <span className="text-ink-muted">Records</span>
                  <span className="text-ink font-mono">142,847,391</span>
                </div>
                <div className="border-rule flex justify-between border-b px-5 py-2 text-xs">
                  <span className="text-ink-muted">Schema</span>
                  <span className="text-link font-mono">CrossrefWork</span>
                </div>
                <div className="border-rule flex justify-between border-b px-5 py-2 text-xs">
                  <span className="text-ink-muted">Published</span>
                  <span className="text-ink font-mono">2024-11-15</span>
                </div>
              </div>
              <div className="border-rule border-b px-5 py-2.5">
                <div className="text-ink-muted mb-0.5 text-[10px] tracking-wider uppercase">
                  Content hash
                </div>
                <code className="text-ink-muted font-mono text-[11px] break-all">
                  sha256:e3b0c44298fc1c14...b855ec4d5d8d0c730e
                </code>
              </div>
              <div className="px-5 py-2.5">
                <div className="flex gap-4 text-[11px]">
                  <span className="text-ink-muted">3 record types</span>
                  <span className="text-ink-muted">47 files</span>
                  <span className="text-ink-muted">8.2 GB</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-rule border-t py-12">
        <div className="mx-auto max-w-5xl px-4">
          <p className="text-ink-muted mb-8 max-w-xl text-sm leading-relaxed">
            Public knowledge should be a public resource: structured, versioned, and accessible.
            Previous attempts required agreement before contribution. LLMs change this — alignment
            happens after the fact. Push what you have. The schemas make it legible.
          </p>
          <div className="grid grid-cols-3 gap-10 text-sm">
            <div>
              <h3 className="text-ink mb-1 font-semibold">GitHub versions code</h3>
              <p className="text-ink-muted leading-relaxed">
                Git diffs are line-oriented. It doesn't know what a "record" or "schema" is.
              </p>
            </div>
            <div>
              <h3 className="text-ink mb-1 font-semibold">Hugging Face versions files</h3>
              <p className="text-ink-muted leading-relaxed">
                Download the whole thing, process locally. No record-level access or schema diffing.
              </p>
            </div>
            <div>
              <h3 className="text-ink mb-1 font-semibold">
                Underlay versions structured knowledge
              </h3>
              <p className="text-ink-muted leading-relaxed">
                Record-level diffs, inspectable schemas, incremental pull. It knows what structure
                means.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-parchment-dark py-10">
        <div className="mx-auto max-w-5xl px-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-ink-muted font-mono text-[11px] tracking-widest uppercase">
              In the registry
            </h2>
            <Link to="/explore" className="text-link text-xs hover:underline">
              View all &rarr;
            </Link>
          </div>
          <div className="border-rule border-t">
            {COLLECTIONS.map((c) => (
              <CollectionRow key={c.slug} c={c} />
            ))}
          </div>
        </div>
      </section>

      <section className="py-10">
        <div className="text-ink-muted mx-auto max-w-5xl px-4 text-center text-xs">
          Open source &middot; MIT licensed &middot; Built by{' '}
          <a href="https://www.knowledgefutures.org" className="text-link hover:underline">
            Knowledge Futures
          </a>
          , a 501(c)(3) nonprofit
        </div>
      </section>
      <Footer />
    </div>
  )
}

// ─── Variant 4: Durable ──────────────────────────────────────────────────────
// Full-width dark hero with the strongest line from the blog. Below:
// the contract, the activity log, and the registry. Maximum gravitas.
function V4() {
  return (
    <div className="min-h-screen font-sans">
      <section className="bg-ink text-parchment">
        <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2.5">
            <img
              src="https://docs.underlay.org/logoLight.svg"
              alt="Underlay"
              className="h-6 invert"
            />
            <span className="text-base font-semibold tracking-tight">Underlay</span>
          </div>
          <div className="flex items-center gap-5 text-sm opacity-60">
            <Link to="/explore" className="hover:opacity-100">
              Explore
            </Link>
            <Link to="/schemas" className="hover:opacity-100">
              Schemas
            </Link>
            <Link to="/docs" className="hover:opacity-100">
              Docs
            </Link>
            <a href="/login" className="hover:opacity-100">
              Log in
            </a>
          </div>
        </nav>

        <div className="mx-auto max-w-5xl px-4 pt-20 pb-24">
          <p className="mb-4 font-mono text-[11px] tracking-widest uppercase opacity-40">
            Permanently addressable structured data
          </p>
          <h1 className="mb-8 max-w-3xl text-4xl leading-[1.15] font-extralight tracking-tight">
            Underlay does not need to be smart. <br />
            It needs to be reliable, durable, and clear.
          </h1>
          <p className="mb-10 max-w-lg text-sm leading-relaxed opacity-50">
            A protocol for giving structured data a permanent address. Push what you have. It gets a
            permanent address. Anyone can point to it, build on it, or align it with something else.
            The intelligence lives in the actors. The infrastructure holds the pieces.
          </p>
          <div className="flex gap-4">
            <Link
              to="/explore"
              className="bg-parchment text-ink hover:bg-parchment-dark px-6 py-3 text-sm font-medium transition-colors"
            >
              Explore the registry
            </Link>
            <Link
              to="/docs/quickstart"
              className="px-6 py-3 text-sm font-medium opacity-50 transition-opacity hover:opacity-100"
              style={{ border: '1px solid currentColor' }}
            >
              Start publishing
            </Link>
          </div>
        </div>
      </section>

      <section className="py-14">
        <div className="mx-auto max-w-5xl px-4">
          <div className="grid grid-cols-[1fr_1fr] items-start gap-12">
            {/* The contract */}
            <div>
              <h2 className="text-ink-muted mb-6 font-mono text-[11px] tracking-widest uppercase">
                The contract
              </h2>
              <div className="space-y-4 text-sm">
                <div className="flex gap-4">
                  <span className="text-rule w-6 flex-shrink-0 font-mono text-lg font-extralight">
                    1
                  </span>
                  <p className="text-ink-muted leading-relaxed">
                    Push JSON records conforming to a JSON Schema.
                  </p>
                </div>
                <div className="flex gap-4">
                  <span className="text-rule w-6 flex-shrink-0 font-mono text-lg font-extralight">
                    2
                  </span>
                  <p className="text-ink-muted leading-relaxed">
                    Underlay stores them as an immutable, content-addressed version.
                  </p>
                </div>
                <div className="flex gap-4">
                  <span className="text-rule w-6 flex-shrink-0 font-mono text-lg font-extralight">
                    3
                  </span>
                  <p className="text-ink-muted leading-relaxed">
                    Each version gets a semver: schema changed (major), records changed (minor).
                  </p>
                </div>
                <div className="flex gap-4">
                  <span className="text-rule w-6 flex-shrink-0 font-mono text-lg font-extralight">
                    4
                  </span>
                  <p className="text-ink-muted leading-relaxed">
                    Version v2.3.0 will always return exactly the same records and schema.
                  </p>
                </div>
                <div className="flex gap-4">
                  <span className="text-rule w-6 flex-shrink-0 font-mono text-lg font-extralight">
                    5
                  </span>
                  <p className="text-ink-muted leading-relaxed">
                    Diff any two versions to see what changed.
                  </p>
                </div>
              </div>
            </div>

            {/* Activity log */}
            <div className="bg-ink text-parchment overflow-hidden font-mono text-[11px] leading-relaxed">
              <div className="border-b border-white/10 px-4 py-2 text-[10px] tracking-wider text-white/30 uppercase">
                Registry activity
              </div>
              <div className="space-y-0 px-4 py-3">
                <div className="border-b border-white/5 py-1.5">
                  <span className="text-white/30">14:23</span>{' '}
                  <span className="text-green-400/70">DEPOSIT</span>{' '}
                  <span className="text-white/60">crossref/metadata-2024</span>
                  <div className="ml-12 text-white/25">v12 · 142M records · sha256:e3b0c4...</div>
                </div>
                <div className="border-b border-white/5 py-1.5">
                  <span className="text-white/30">14:22</span>{' '}
                  <span className="text-blue-400/70">VERIFY</span>{' '}
                  <span className="text-white/60">mirror-iua.org/datacite/doi-registry</span>
                  <div className="ml-12 text-white/25">v24 · hash match confirmed</div>
                </div>
                <div className="border-b border-white/5 py-1.5">
                  <span className="text-white/30">14:21</span>{' '}
                  <span className="text-green-400/70">DEPOSIT</span>{' '}
                  <span className="text-white/60">orcid/public-data</span>
                  <div className="ml-12 text-white/25">v8 · 19M records · sha256:a1f8d2...</div>
                </div>
                <div className="border-b border-white/5 py-1.5">
                  <span className="text-white/30">14:20</span>{' '}
                  <span className="text-yellow-400/70">SCHEMA</span>{' '}
                  <span className="text-white/60">OpenAlexWork v2.1.0</span>
                  <div className="ml-12 text-white/25">3 fields added, 0 breaking</div>
                </div>
                <div className="py-1.5">
                  <span className="text-white/30">14:19</span>{' '}
                  <span className="text-blue-400/70">VERIFY</span>{' '}
                  <span className="text-white/60">mirror-harvard.edu/crossref</span>
                  <div className="ml-12 text-white/25">v11 · hash match confirmed</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-parchment-dark py-10">
        <div className="mx-auto max-w-5xl px-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-ink-muted font-mono text-[11px] tracking-widest uppercase">
              Collections
            </h2>
            <Link to="/explore" className="text-link text-xs hover:underline">
              View all &rarr;
            </Link>
          </div>
          <div className="border-rule border-t">
            {COLLECTIONS.map((c) => (
              <CollectionRow key={c.slug} c={c} />
            ))}
          </div>
        </div>
      </section>

      <section className="py-10">
        <div className="text-ink-muted mx-auto max-w-5xl px-4 text-center text-xs">
          Open source &middot; MIT licensed &middot; Built by{' '}
          <a href="https://www.knowledgefutures.org" className="text-link hover:underline">
            Knowledge Futures
          </a>
          , a 501(c)(3) nonprofit
        </div>
      </section>
      <Footer />
    </div>
  )
}

export default function LandingDev() {
  const [variant, setVariant] = useState(1)
  return (
    <>
      <Nav current={variant} onChange={setVariant} />
      <div className="pt-8">
        {variant === 1 && <V1 />}
        {variant === 2 && <V2 />}
        {variant === 3 && <V3 />}
        {variant === 4 && <V4 />}
      </div>
    </>
  )
}
