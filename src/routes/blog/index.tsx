import { Link } from 'react-router'

import BaseLayout from '~/components/BaseLayout'

const posts: { title: string; subtitle: string; date: string; url: string }[] = [
  {
    title: 'Schema Evolution',
    subtitle: 'How Underlay handles schema changes across versions.',
    date: '2026-04-30',
    url: '/blog/2026-04-30-schema-evolution',
  },
  {
    title: 'AT Protocol Integration',
    subtitle: 'Connecting Underlay to the decentralized social web.',
    date: '2026-04-28',
    url: '/blog/2026-04-28-atproto-integration',
  },
  {
    title: 'Institutional Repositories',
    subtitle: 'Why universities need better infrastructure for structured data.',
    date: '2024-04-27',
    url: '/blog/2024-04-27-institutional-repositories',
  },
  {
    title: 'Underlay, Revived',
    subtitle: 'The landscape changed. The project can finally be simple.',
    date: '2024-04-27',
    url: '/blog/2024-04-27-underlay-revived',
  },
]

function fmtDate(d: string) {
  const date = new Date(d)
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function isoDate(d: string) {
  return new Date(d).toISOString().slice(0, 10)
}

export default function Blog() {
  return (
    <BaseLayout>
      <div className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-6 font-sans text-xl font-semibold tracking-tight">Blog</h1>

        <ul className="space-y-3">
          {posts.map((post) => (
            <li key={post.url} className="flex items-baseline gap-3">
              <time
                className="text-ink-muted w-24 shrink-0 text-xs tabular-nums"
                dateTime={isoDate(post.date)}
              >
                {fmtDate(post.date)}
              </time>
              <div>
                <Link to={post.url} className="text-link text-sm font-semibold underline">
                  {post.title}
                </Link>
                <p className="text-ink-muted mt-0.5 text-xs">{post.subtitle}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </BaseLayout>
  )
}
