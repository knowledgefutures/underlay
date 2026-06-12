import { useEffect, useRef } from 'react'
import { Link, useLoaderData } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'

function HeroBackground() {
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  const boxesRef = useRef<HTMLDivElement[]>([])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const w = container.offsetWidth
    const h = container.offsetHeight
    const count = 14

    const rng = (i: number) => {
      let s = (i * 2654435761 + 17) >>> 0
      s = ((s ^ (s >> 16)) * 0x45d9f3b) >>> 0
      s = ((s ^ (s >> 16)) * 0x45d9f3b) >>> 0
      return (s >>> 0) / 0xffffffff
    }

    const boxes = Array.from({ length: count }, (_, i) => {
      const el = document.createElement('div')
      const size = 20 + rng(i * 7) * 120
      const aspect = 0.5 + rng(i * 7 + 5) * 1.0
      el.style.cssText = `
        position:absolute;
        width:${size}px;
        height:${size * aspect}px;
        background:rgba(235,228,214,${0.25 + rng(i * 7 + 6) * 0.3});
        border-radius:${2 + rng(i * 7 + 4) * 4}px;
        pointer-events:none;
      `
      container.appendChild(el)
      return {
        el,
        x: rng(i * 7 + 1) * w,
        y: rng(i * 7 + 2) * h,
        vx: (rng(i * 7 + 3) - 0.5) * 0.35,
        vy: (rng(i * 7 + 4) - 0.5) * 0.3,
        rot: rng(i * 7 + 5) * 360,
        vr: (rng(i * 7 + 6) - 0.5) * 0.08,
        size,
      }
    })

    const animate = () => {
      for (const b of boxes) {
        b.x += b.vx
        b.y += b.vy
        b.rot += b.vr
        if (b.x < -b.size) b.x = w + b.size
        if (b.x > w + b.size) b.x = -b.size
        if (b.y < -b.size) b.y = h + b.size
        if (b.y > h + b.size) b.y = -b.size
        b.el.style.transform = `translate(${b.x}px,${b.y}px) rotate(${b.rot}deg)`
      }
      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)
    boxesRef.current = boxes.map((b) => b.el)

    return () => {
      cancelAnimationFrame(rafRef.current)
      for (const el of boxesRef.current) el.remove()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    />
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

interface RegistryCollection {
  slug: string
  ownerSlug: string
  description?: string
  semver: string | null
  recordCount: number | null
  totalBytes: number | null
  lastPushAt: string | null
}

export default function Home() {
  const { mirrorConfig } = useAppContext()
  const data = useLoaderData() as { featured?: RegistryCollection[] } | undefined
  const collections: RegistryCollection[] = data?.featured ?? []

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
                  Each copy is cryptographically verified. Tamper-evident by design.
                </p>
              </div>
              <div>
                <h3 className="mb-1 font-sans font-semibold">Independent infrastructure</h3>
                <p className="text-ink-muted">
                  Running on separate hardware with its own database and storage. No single point of
                  failure. If the upstream goes down, the data persists here.
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
                  Anyone can run a mirror. Same software, different server.
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
      {/* Hero */}
      <section className="relative overflow-hidden">
        <HeroBackground />
        <div className="relative mx-auto max-w-5xl px-4 py-16">
          <div className="max-w-2xl">
            <h1 className="mb-4 font-sans text-3xl leading-tight font-semibold tracking-tight md:text-4xl">
              A protocol for radically accessible structured knowledge.
            </h1>
            <p className="text-ink-light mb-3 max-w-xl text-sm leading-relaxed">
              Publish structured data as versioned, permanent collections with schemas, provenance,
              and content addressing built in. Whether you're a research lab, a newsroom, a
              community archive, or a single developer, Underlay makes the knowledge you hold
              discoverable, verifiable, and easy to build on.
            </p>
            <p className="text-ink-muted mb-8 max-w-xl text-xs leading-relaxed">
              Stewarded by Knowledge Futures, a 501(c)(3) public charity dedicated to building
              open-source knowledge infrastructure.
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
                Get started
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* In the registry */}
      {collections.length > 0 && (
        <section className="bg-parchment-dark border-rule border-y">
          <div className="mx-auto max-w-5xl px-4 py-16">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-ink-muted text-xs font-semibold tracking-widest uppercase">
                In the registry
              </h2>
              <Link
                to="/explore"
                className="text-ink-muted hover:text-ink text-xs transition-colors"
              >
                Explore all collections →
              </Link>
            </div>
            <div className="border-rule overflow-hidden rounded border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-ink/5 text-ink-muted text-left text-xs">
                    <th className="px-3 py-2 font-medium">Collection</th>
                    <th className="px-3 py-2 font-medium">Records</th>
                    <th className="px-3 py-2 font-medium">Latest</th>
                    <th className="px-3 py-2 text-right font-medium">Size</th>
                    <th className="px-3 py-2 text-right font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {collections.map((c, i) => (
                    <tr
                      key={`${c.ownerSlug}/${c.slug}`}
                      className={`bg-parchment hover:bg-parchment/80 transition-colors ${i < collections.length - 1 ? 'border-rule border-b' : ''}`}
                    >
                      <td className="px-3 py-2.5">
                        <Link
                          to={`/${c.ownerSlug}/${c.slug}`}
                          className="text-link font-medium hover:underline"
                        >
                          {c.ownerSlug}/{c.slug}
                        </Link>
                      </td>
                      <td className="text-ink-muted px-3 py-2.5 font-mono text-xs">
                        {c.recordCount != null ? formatCount(c.recordCount) : '—'}
                      </td>
                      <td className="text-ink-muted px-3 py-2.5 font-mono text-xs">
                        {c.semver ?? '—'}
                      </td>
                      <td className="text-ink-muted px-3 py-2.5 text-right font-mono text-xs">
                        {c.totalBytes != null ? formatBytes(c.totalBytes) : '—'}
                      </td>
                      <td className="text-ink-muted px-3 py-2.5 text-right text-xs">
                        {c.lastPushAt ? timeAgo(c.lastPushAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* The workflow */}
      <section className="border-rule border-t">
        <div className="mx-auto max-w-5xl px-4 py-16">
          <div className="grid grid-cols-1 gap-8 md:grid-cols-[1fr_1fr]">
            <div>
              <h2 className="text-ink-muted mb-4 text-xs font-semibold tracking-widest uppercase">
                The workflow
              </h2>
              <p className="text-ink-light mb-4 text-sm leading-relaxed">
                An agent, an app, a scraper, a researcher: any tool that can push JSON records and
                pull versions. Five commands from JSON to a permanent version.
              </p>
              <Link to="/docs/quickstart" className="text-link text-sm hover:underline">
                Read the quickstart →
              </Link>
            </div>
            <div className="bg-ink text-parchment overflow-hidden rounded font-mono text-[13px] leading-relaxed">
              <div className="p-5">
                <div className="text-ink-muted mb-1 text-[11px] select-none">
                  # point at a collection
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay init --schema
                  ./schema.json
                </div>
                <div className="text-ink-muted mt-3 mb-1 text-[11px] select-none">
                  # stage and push records
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay add ./records.jsonl
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay commit -m &quot;Q2 article
                  refresh&quot;
                </div>
                <div className="text-ink-muted mt-3 mb-1 text-[11px] select-none">
                  # done. versioned and permanent
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay push
                </div>
                <div className="text-accent-light mt-1">
                  published v1.2.0 &middot; 4,218 records &middot; immutable
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Bottom dark section */}
      <section className="bg-ink text-parchment">
        <div className="mx-auto max-w-5xl px-4 py-16">
          <h2 className="mb-4 font-sans text-2xl leading-snug font-semibold tracking-tight md:max-w-2xl md:text-3xl">
            Push what you have. The schemas make it legible. The models make it interoperable.
          </h2>
          <p className="text-parchment-dark mb-10 max-w-xl text-sm leading-relaxed">
            Aligning structured data across organizations used to require everyone to agree on a
            common schema upfront. Modern tooling has changed that. Schemas travel with the data,
            and alignment can happen at the point of use rather than at the point of publication.
            All you need to do is publish what you have, in whatever structure you already have it.
          </p>
          <div className="grid grid-cols-1 gap-8 text-sm md:grid-cols-3">
            <div>
              <h3 className="mb-1 font-sans font-semibold">Explore collections</h3>
              <p className="text-parchment-dark mb-2 text-xs leading-relaxed">
                Browse the public registry.
              </p>
              <Link
                to="/explore"
                className="text-parchment-dark hover:text-parchment text-xs underline"
              >
                Explore →
              </Link>
            </div>
            <div>
              <h3 className="mb-1 font-sans font-semibold">Read the docs</h3>
              <p className="text-parchment-dark mb-2 text-xs leading-relaxed">
                Quickstart, concepts, API.
              </p>
              <Link
                to="/docs"
                className="text-parchment-dark hover:text-parchment text-xs underline"
              >
                Docs →
              </Link>
            </div>
            <div>
              <h3 className="mb-1 font-sans font-semibold">Read the protocol</h3>
              <p className="text-parchment-dark mb-2 text-xs leading-relaxed">
                The reference-grade spec.
              </p>
              <Link
                to="/protocol"
                className="text-parchment-dark hover:text-parchment text-xs underline"
              >
                Protocol →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </BaseLayout>
  )
}
