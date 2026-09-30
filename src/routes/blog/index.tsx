import { Link } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { blogPosts } from '~/lib/blog-posts'

const posts = blogPosts.map((p) => ({ ...p, url: `/blog/${p.slug}` }))

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
