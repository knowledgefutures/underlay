import { Link, } from 'react-router'
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

function fmtDate(d: string,) {
  const date = new Date(d,)
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', },)
}

function isoDate(d: string,) {
  return new Date(d,).toISOString().slice(0, 10,)
}

export default function Blog() {
  return (
    <BaseLayout>
      <div className='max-w-2xl mx-auto px-4 py-10'>
        <h1 className='text-xl font-semibold tracking-tight font-sans mb-6'>Blog</h1>

        <ul className='space-y-3'>
          {posts.map((post,) => (
            <li key={post.url} className='flex items-baseline gap-3'>
              <time className='text-xs text-ink-muted tabular-nums shrink-0 w-24' dateTime={isoDate(post.date,)}>
                {fmtDate(post.date,)}
              </time>
              <div>
                <Link to={post.url} className='text-sm font-semibold text-link underline'>{post.title}</Link>
                <p className='text-xs text-ink-muted mt-0.5'>{post.subtitle}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </BaseLayout>
  )
}
