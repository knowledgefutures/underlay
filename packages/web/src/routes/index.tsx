import { useEffect, useRef, useState } from 'react'
import { Form, Link, useLoaderData } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { ButtonLink } from '~/components/ui'
import { formatCount, tagLabel } from '~/lib/format'
import { KF_SITE } from '~/lib/kf-updates'

import type { HomeCollection, HomeExample } from './index.data'

function HeroBackground() {
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  const boxesRef = useRef<HTMLDivElement[]>([])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // CSS can't stop a rAF loop, so honor reduced motion here explicitly.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

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

const SITE = 'https://www.underlay.org'

function SearchIcon({ className }: { className: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function SectionHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-8 max-w-2xl">
      <h2 className="font-sans text-2xl leading-snug font-semibold tracking-tight">{title}</h2>
      {children && <p className="text-ink-light mt-2 text-[15px] leading-relaxed">{children}</p>}
    </div>
  )
}

const FACTS = [
  {
    title: 'Versioned',
    body: 'Versions are numbered (v1.2.0) and immutable. Earlier versions remain available, so any result can be traced to the data it used.',
    icon: (
      <>
        <circle cx="5" cy="10" r="2.2" />
        <circle cx="15" cy="10" r="2.2" />
        <path d="M7.2 10h5.6" />
      </>
    ),
  },
  {
    title: 'Self-describing',
    body: 'Every record type has a JSON Schema, and every collection has a README stating its source and license.',
    icon: (
      <>
        <rect x="3.5" y="3.5" width="13" height="13" rx="1" />
        <path d="M6.5 7.5h7M6.5 10h7M6.5 12.5h4" />
      </>
    ),
  },
  {
    title: 'Citable',
    body: 'Collections and versions receive ARK identifiers for use in citations and data availability statements.',
    icon: (
      <>
        <path d="M8 12a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.8.8" />
        <path d="M12 8a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.8-.8" />
      </>
    ),
  },
  {
    title: 'Open and portable',
    body: 'Public collections are readable without an account. Any version can be exported in full, and the published protocol allows other hosts to serve the same data.',
    icon: (
      <>
        <circle cx="10" cy="10" r="7" />
        <path d="M4 10h12M10 4v12" />
      </>
    ),
  },
]

function ExampleCard({ example }: { example: HomeExample }) {
  const path = `${example.owner}/${example.slug}`
  return (
    <figure className="border-rule rounded-surface bg-parchment-dark/30 m-0 min-w-0 border text-[13px]">
      <div className="border-rule border-b px-4 py-3.5">
        <Link to={`/${path}`} className="text-ink-muted font-mono text-xs hover:underline">
          {path}
        </Link>
        <p className="mt-0.5 text-base font-semibold">{example.name}</p>
      </div>
      <dl className="m-0">
        <Row label="Version">
          <span className="bg-ink text-parchment rounded-control px-1.5 py-0.5 font-mono text-xs">
            {example.semver}
          </span>
          <span className="text-ink-muted ml-2 text-xs">
            latest · {example.recordCount.toLocaleString('en-US')} records
          </span>
        </Row>
        <Row label="Types">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-1">
            {example.typeCounts.map((t) => (
              <span key={t.type} className="flex justify-between gap-2">
                <code className="text-xs">{t.type}</code>
                <span className="text-ink-muted text-xs tabular-nums">
                  {t.count.toLocaleString('en-US')}
                </span>
              </span>
            ))}
          </div>
        </Row>
        {example.record && (
          <Row label="Record">
            <pre className="text-ink-light m-0 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {recordPreview(example.record)}
            </pre>
          </Row>
        )}
        {example.ark && (
          <Row label="ARK">
            <a href={example.ark} className="text-link font-mono text-xs break-all hover:underline">
              {example.ark.replace(/^https?:\/\//, '')}
            </a>
          </Row>
        )}
      </dl>
      <figcaption className="bg-parchment-dark text-ink-muted px-4 py-2.5 text-xs">
        Imported from the NASA Exoplanet Archive by Knowledge Futures.
      </figcaption>
    </figure>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-rule grid grid-cols-[84px_minmax(0,1fr)] items-baseline gap-3 border-b px-4 py-3 last:border-b-0">
      <dt className="text-ink-muted text-[11px] font-semibold tracking-wider uppercase">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  )
}

function recordPreview(r: NonNullable<HomeExample['record']>) {
  const fields = Object.entries(r.data)
    .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n')
  return `{ "id": ${JSON.stringify(r.id)}, "type": ${JSON.stringify(r.type)},\n  "data": {\n${fields}\n  } }`
}

type UseTab = 'browse' | 'download' | 'api' | 'cite' | 'agents'
const USE_TABS: [UseTab, string][] = [
  ['browse', 'Browse'],
  ['download', 'Download'],
  ['api', 'Query the API'],
  ['cite', 'Cite'],
  ['agents', 'With an AI agent'],
]

function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <div>
      {label && (
        <p className="text-parchment-dark/70 px-4 pt-3 text-[11px] tracking-wider uppercase">
          {label}
        </p>
      )}
      <pre className="m-0 overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  )
}

function UseTheData({ example }: { example: HomeExample | null }) {
  const [tab, setTab] = useState<UseTab>('browse')
  const [lang, setLang] = useState<'curl' | 'python' | 'js'>('curl')
  const [copied, setCopied] = useState(false)

  const owner = example?.owner ?? 'nasa'
  const slug = example?.slug ?? 'exoplanets'
  const path = `${owner}/${slug}`
  const semver = example?.semver ?? 'v1.0.0'
  const type = example?.typeCounts[0]?.type ?? 'Planet'
  const typeCount = example?.typeCounts[0]?.count
  const recordsUrl = `${SITE}/api/collections/${path}/versions/${semver}/records`
  const snippets = {
    curl: `# ${type} records in ${semver}, 2 at a time\ncurl "${recordsUrl}?type=${type}&limit=2"`,
    python: `import requests\n\nurl = "${recordsUrl}"\npage = requests.get(url, params={"type": "${type}", "limit": 100}).json()\n\nfor r in page["records"]:\n    print(r["id"], r["data"])`,
    js: `const url = "${recordsUrl}?type=${type}&limit=100"\nconst { records, pagination } = await fetch(url).then((r) => r.json())\n\nfor (const r of records) console.log(r.id, r.data)\n// pagination.nextCursor fetches the next page`,
  }
  const response = `{
  "records": [
    { "id": "${example?.record?.id ?? '…'}", "type": "${type}",
      "data": { … }, "hash": "…" },
    …
  ],
  "pagination": { "limit": 2, "hasMore": true,${typeCount ? ` "total": ${typeCount},` : ''}
                  "nextCursor": "…" }
}`
  const citeText = `${example?.name ?? path} (Version ${semver}) [Data set]. Underlay. ${example?.ark ?? `${SITE}/${path}`}`
  const citeBib = `@misc{${path.replace(/[^a-z0-9]+/gi, '_')}_${semver.replace(/\W+/g, '_')},
  title     = {${example?.name ?? path}},
  version   = {${semver}},
  publisher = {Underlay},
  url       = {${example?.ark ?? `${SITE}/${path}`}}
}`

  function copy() {
    navigator.clipboard
      ?.writeText(snippets[lang])
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  return (
    <>
      <div className="border-rule flex overflow-x-auto border-b" role="tablist">
        {USE_TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px shrink-0 border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors ${
              tab === key
                ? 'border-ink text-ink'
                : 'text-ink-muted hover:text-ink border-transparent'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-7 pt-7 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        {tab === 'browse' && (
          <>
            <TabCopy title="Web interface">
              <p>
                Each collection page shows its README, record types, schemas, and version history.
                Records can be filtered by type, and any two versions can be compared.
              </p>
              <Link to={`/${path}`} className="text-link text-sm hover:underline">
                Open {path} →
              </Link>
            </TabCopy>
            <div className="border-rule rounded-surface min-w-0 overflow-hidden border">
              <div className="bg-parchment-dark border-rule text-ink-muted border-b px-3 py-2 font-mono text-[11px]">
                underlay.org/{path}/records?type={type}
              </div>
              <div className="text-ink-muted flex flex-wrap gap-4 px-4 pt-3 text-xs">
                <span>Overview</span>
                <span className="text-ink font-semibold">Records</span>
                <span>Schemas</span>
                <span>Versions</span>
                <span>Files</span>
              </div>
              <div className="p-4">
                {example?.typeCounts.length ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-parchment-dark text-ink-muted text-left">
                        <th className="px-2 py-1.5 font-medium">Type</th>
                        <th className="px-2 py-1.5 text-right font-medium">Records</th>
                      </tr>
                    </thead>
                    <tbody>
                      {example.typeCounts.map((t) => (
                        <tr key={t.type} className="border-rule border-t">
                          <td className="px-2 py-1.5 font-mono">{t.type}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                            {t.count.toLocaleString('en-US')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </div>
            </div>
          </>
        )}

        {tab === 'download' && (
          <>
            <TabCopy title="Bulk download">
              <p>
                Each version is available as a single archive containing the README, a manifest with
                the version hash, and one NDJSON file per record type.
              </p>
              <a
                href={`/api/collections/${path}/export`}
                className="text-link text-sm hover:underline"
                rel="nofollow"
              >
                Download {path} (.tar.gz) →
              </a>
            </TabCopy>
            <div className="bg-ink text-parchment rounded-surface min-w-0 overflow-hidden">
              <CodeBlock label={`${owner}-${slug}-${semver}.tar.gz`}>
                {[
                  'README.md',
                  'manifest.json',
                  'records/',
                  ...(example?.typeCounts ?? [{ type, count: 0 }]).map((t) => `  ${t.type}.ndjson`),
                ].join('\n')}
              </CodeBlock>
            </div>
          </>
        )}

        {tab === 'api' && (
          <>
            <TabCopy title="HTTP API">
              <p>
                Records are served as JSON over HTTPS. Requests can target the latest version or a
                specific version for reproducible results.
              </p>
              <ul className="text-ink-light m-0 list-disc space-y-1 pl-5 text-sm">
                <li>Paginated records, filterable by type</li>
                <li>Single records by ID or hash</li>
                <li>Version history and diffs between versions</li>
              </ul>
              <Link to="/docs/api/records" className="text-link text-sm hover:underline">
                API reference →
              </Link>
            </TabCopy>
            <div className="bg-ink text-parchment rounded-surface min-w-0 overflow-hidden">
              <div className="flex items-center gap-1 border-b border-white/10 px-2 pt-1.5">
                {(
                  [
                    ['curl', 'curl'],
                    ['python', 'Python'],
                    ['js', 'JavaScript'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setLang(key)}
                    className={`border-b-2 px-2.5 py-1.5 text-xs ${
                      lang === key
                        ? 'text-parchment border-accent-light'
                        : 'text-parchment-dark/60 hover:text-parchment border-transparent'
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <button
                  onClick={copy}
                  className="text-parchment-dark/70 hover:text-parchment rounded-control mb-1.5 ml-auto border border-white/15 px-2 py-0.5 text-xs"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <CodeBlock>{snippets[lang]}</CodeBlock>
              <div className="border-t border-white/10">
                <CodeBlock label="Response">{response}</CodeBlock>
              </div>
            </div>
          </>
        )}

        {tab === 'cite' && (
          <>
            <TabCopy title="Citation">
              <p>
                A version&rsquo;s ARK and hash identify a fixed set of records, which remains
                available after the collection is updated. Both are shown on each collection and
                version page.
              </p>
            </TabCopy>
            <div className="min-w-0 space-y-2.5">
              <div className="border-rule rounded-surface border p-4 text-sm leading-relaxed">
                <p className="text-ink-muted mb-1.5 text-[11px] font-semibold tracking-wider uppercase">
                  Example citation
                </p>
                <p className="break-words">{citeText}</p>
              </div>
              <div className="border-rule rounded-surface border p-4">
                <p className="text-ink-muted mb-1.5 text-[11px] font-semibold tracking-wider uppercase">
                  BibTeX
                </p>
                <pre className="m-0 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                  {citeBib}
                </pre>
              </div>
            </div>
          </>
        )}

        {tab === 'agents' && (
          <>
            <TabCopy title="AI agents">
              <p>
                Underlay publishes a machine-readable guide to its API at{' '}
                <a href="/llms.txt" className="text-link font-mono text-xs hover:underline">
                  underlay.org/llms.txt
                </a>{' '}
                for AI agents and coding assistants.
              </p>
            </TabCopy>
            <div className="border-rule rounded-surface min-w-0 border p-4 text-sm leading-relaxed">
              <p className="text-ink-muted mb-1.5 text-[11px] font-semibold tracking-wider uppercase">
                Example prompt
              </p>
              <p>
                Using underlay.org/llms.txt, get the {type} records from underlay.org/{path}{' '}
                {semver} and summarize them in a table.
              </p>
            </div>
          </>
        )}
      </div>
    </>
  )
}

function TabCopy({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="text-ink-light grid min-w-0 content-start gap-3 text-[14.5px] leading-relaxed">
      <h3 className="text-ink text-lg font-semibold tracking-tight">{title}</h3>
      {children}
    </div>
  )
}

function CollectionCard({ c }: { c: HomeCollection }) {
  return (
    <Link
      to={`/${c.ownerSlug}/${c.slug}`}
      className="border-rule hover:border-ink-muted/50 rounded-surface grid min-w-0 grid-rows-[auto_auto_1fr_auto] gap-1.5 border p-4 transition-all hover:shadow-sm"
    >
      <span className="text-ink-muted truncate font-mono text-[11.5px]">
        {c.ownerSlug}/{c.slug}
      </span>
      <span className="text-[15px] font-semibold">{c.name}</span>
      <span className="text-ink-light line-clamp-3 text-[13px] leading-normal">
        {c.description}
      </span>
      <span className="border-rule text-ink-muted mt-1.5 flex flex-wrap gap-3 border-t pt-2 text-xs tabular-nums">
        {c.recordCount != null && <span>{formatCount(c.recordCount)} records</span>}
        {c.semver && <span className="font-mono">{c.semver}</span>}
        {c.tags.length > 0 && <span>{c.tags.map(tagLabel).join(', ')}</span>}
      </span>
    </Link>
  )
}

const AUDIENCES = [
  [
    'Researchers and labs',
    'Publish the data behind published results, with a version and identifier that match each paper.',
  ],
  [
    'Journals and publishers',
    'Publish article metadata, reviews, and claims as typed records that indexers can query. Updates never break existing links.',
  ],
  [
    'Archives and libraries',
    'Maintain catalogs with their full history, readable by people and machines and exportable in full.',
  ],
  [
    'Developers and data teams',
    'Integrate a pinned version into an app or pipeline, and review the changes in each new version before adopting it.',
  ],
]

const STEPS = [
  [
    'Create a collection',
    'Sign in with a Knowledge Futures account and create a public or private collection under a personal or organization account.',
  ],
  [
    'Define schemas',
    'Each record type is described by a JSON Schema. Records that fail validation are rejected.',
  ],
  [
    'Push a version',
    'Records are pushed through the API and committed as a numbered, immutable version.',
  ],
]

const PILLARS = [
  {
    title: 'Run by a nonprofit',
    body: 'Each Knowledge Futures project adds to an open-source, privacy-respecting foundation for public knowledge.',
    link: { href: KF_SITE, label: 'About Knowledge Futures' },
  },
  {
    title: 'Open protocol',
    body: 'Records, versions, and hashing are defined in a public specification.',
    link: { href: '/docs/protocol', label: 'Read the protocol' },
  },
  {
    title: 'Open source',
    body: 'The registry’s source code is public on GitHub.',
    link: { href: 'https://github.com/knowledgefutures/underlay', label: 'View on GitHub' },
  },
  {
    title: 'Portable',
    body: 'Every version exports in full, with schemas and hashes, for independent verification or hosting elsewhere.',
    link: { href: '/docs/api/sync-and-integrations#export', label: 'How export works' },
  },
]

export default function Home() {
  const data = useLoaderData() as
    | { featured?: HomeCollection[]; example?: HomeExample | null }
    | undefined
  const featured = data?.featured ?? []
  const example = data?.example ?? null

  return (
    <BaseLayout>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <HeroBackground />
        <div className="relative mx-auto max-w-5xl px-4 pt-16 pb-14">
          <h1 className="max-w-[24ch] font-sans text-3xl leading-tight font-semibold tracking-tight text-balance md:text-[2.625rem] md:leading-[1.12]">
            A protocol for radically accessible structured knowledge.
          </h1>
          <p className="text-ink-light mt-4 max-w-[58ch] text-base leading-relaxed">
            Underlay is what institutions use to steward, curate, and publish their data.
            Universities, libraries, foundations, research labs, and publishers maintain open,
            versioned collections that anyone can cite and build on.
          </p>
          <Form action="/explore" method="get" role="search" className="mt-7 flex max-w-xl gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="text-ink-muted pointer-events-none absolute top-1/2 left-3.5 h-[18px] w-[18px] -translate-y-1/2" />
              <input
                type="search"
                name="q"
                placeholder="Search collections and organizations"
                aria-label="Search collections and organizations"
                className="bg-parchment border-rule placeholder:text-ink-muted focus:border-ink rounded-control h-12 w-full border pr-3 pl-11 text-[15px] focus:outline-none"
              />
            </div>
            <button
              type="submit"
              className="bg-ink text-parchment hover:bg-ink-light rounded-control h-12 shrink-0 px-5 text-sm font-medium transition-colors"
            >
              Search
            </button>
          </Form>
          <p className="text-ink-muted mt-7 text-xs">
            A project of Knowledge Futures, a 501(c)(3) public charity.
          </p>
        </div>
      </section>

      {/* Collections */}
      <section className="border-rule border-t">
        <div className="mx-auto max-w-5xl px-4 py-16">
          <SectionHead title="Collections">
            A collection is a dataset published as typed JSON records. Each update is validated
            against its schemas and stored as a new, immutable version.
          </SectionHead>
          <div className="grid grid-cols-1 items-start gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            <div className="grid gap-5">
              {FACTS.map((f) => (
                <div key={f.title} className="grid grid-cols-[22px_1fr] gap-3">
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    className="text-accent mt-0.5 h-[18px] w-[18px]"
                    aria-hidden="true"
                  >
                    {f.icon}
                  </svg>
                  <div>
                    <h3 className="mb-0.5 text-[15px] font-semibold">{f.title}</h3>
                    <p className="text-ink-light text-sm leading-relaxed">{f.body}</p>
                  </div>
                </div>
              ))}
            </div>
            {example && <ExampleCard example={example} />}
          </div>
        </div>
      </section>

      {/* Using the data */}
      <section id="use" className="border-rule border-t">
        <div className="mx-auto max-w-5xl px-4 py-16">
          <SectionHead title="Using the data">
            Public collections require no account or API key.
            {example && (
              <>
                {' '}
                Examples use{' '}
                <span className="font-mono text-sm">{`${example.owner}/${example.slug}`}</span>.
              </>
            )}
          </SectionHead>
          <UseTheData example={example} />
        </div>
      </section>

      {/* In the registry */}
      {featured.length > 0 && (
        <section className="border-rule border-t">
          <div className="mx-auto max-w-5xl px-4 py-16">
            <SectionHead title="In the registry" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {featured.map((c) => (
                <CollectionCard key={`${c.ownerSlug}/${c.slug}`} c={c} />
              ))}
            </div>
            <div className="text-ink-muted mt-5 flex flex-wrap justify-between gap-3 text-[13px]">
              {/* Most public collections are KF's imports for now; drop this once publishers'
                  own collections fill the featured list (admin → Explore). */}
              <span>
                Includes reference datasets imported from public sources by Knowledge Futures.
                Sources and licenses are listed in each README.
              </span>
              <Link to="/explore" className="text-link hover:underline">
                Search all collections →
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* Audiences */}
      <section className="border-rule border-t">
        <div className="mx-auto max-w-5xl px-4 py-16">
          <SectionHead title="For institutions that steward data" />
          <div className="bg-rule border-rule rounded-surface grid grid-cols-1 gap-px overflow-hidden border md:grid-cols-2">
            {AUDIENCES.map(([title, body]) => (
              <div key={title} className="bg-parchment grid content-start gap-1.5 p-5">
                <h3 className="text-[15px] font-semibold">{title}</h3>
                <p className="text-ink-light text-sm leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Publishing */}
      <section className="border-rule border-t">
        <div className="mx-auto max-w-5xl px-4 py-16">
          <SectionHead title="Publishing">
            Data is published in its existing structure. Schemas describe it once, and each
            subsequent push creates a new version.
          </SectionHead>
          <ol className="m-0 grid list-none grid-cols-1 gap-6 p-0 md:grid-cols-3">
            {STEPS.map(([title, body], i) => (
              <li key={title} className="grid content-start gap-1.5">
                <span className="border-ink mb-1.5 flex h-[26px] w-[26px] items-center justify-center rounded-full border text-xs font-semibold">
                  {i + 1}
                </span>
                <h3 className="text-[15px] font-semibold">{title}</h3>
                <p className="text-ink-light text-sm leading-relaxed">{body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ButtonLink to="/docs/quickstart" size="lg">
              Read the quickstart
            </ButtonLink>
            <ButtonLink to="/login" variant="secondary" size="lg" reloadDocument>
              Sign in
            </ButtonLink>
            <span className="text-ink-muted text-[13px]">
              Institutional publishing:{' '}
              <span className="text-ink font-mono text-xs">help@underlay.org</span>
            </span>
          </div>
        </div>
      </section>

      {/* Nonprofit, open, and portable */}
      <section className="bg-ink text-parchment">
        <div className="mx-auto max-w-5xl px-4 py-16">
          <h2 className="max-w-[30ch] font-sans text-2xl leading-snug font-semibold tracking-tight md:text-[28px]">
            Nonprofit, open, and portable.
          </h2>
          <p className="text-parchment-dark mt-3 max-w-[60ch] text-[15px] leading-relaxed">
            Underlay is built by Knowledge Futures, a 501(c)(3) public charity building the tools
            communities need to share, curate, and steward knowledge openly and sustainably. Its
            protocol, code, and export format are open, so collections never depend on a single
            host.
          </p>
          <div className="mt-9 grid grid-cols-1 gap-7 sm:grid-cols-2 lg:grid-cols-4">
            {PILLARS.map((p) => (
              <div key={p.title}>
                <h3 className="mb-1 text-sm font-semibold">{p.title}</h3>
                <p className="text-parchment-dark text-[13px] leading-relaxed">{p.body}</p>
                <a
                  href={p.link.href}
                  className="text-parchment-dark visited:text-parchment-dark hover:text-parchment mt-1.5 inline-block text-xs underline"
                >
                  {p.link.label}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>
    </BaseLayout>
  )
}
