import { useSSRData } from '~/lib/ssr-data'
import BlogLayout from '~/components/BlogLayout'
import { useParams } from 'react-router'
import { useState, useEffect } from 'react'

// Blog post metadata
const posts: Record<string, { title: string; subtitle: string; date: string }> = {
  '2024-04-27-underlay-revived': {
    title: 'Underlay, Revived',
    subtitle: 'The landscape changed. The project can finally be simple.',
    date: '2024-04-27',
  },
  '2024-04-27-institutional-repositories': {
    title: 'Institutional Repositories',
    subtitle: 'Why universities need better infrastructure for structured data.',
    date: '2024-04-27',
  },
  '2026-04-28-atproto-integration': {
    title: 'AT Protocol Integration',
    subtitle: 'Connecting Underlay to the decentralized social web.',
    date: '2026-04-28',
  },
  '2026-04-30-schema-evolution': {
    title: 'Schema Evolution',
    subtitle: 'How Underlay handles schema changes across versions.',
    date: '2026-04-30',
  },
}

export default function BlogPost() {
  const { slug } = useParams()
  const [content, setContent] = useState<string | null>(null)

  const meta = slug ? posts[slug] : undefined

  useEffect(() => {
    if (!slug) return
    // Fetch the rendered markdown from an API endpoint or static file
    fetch(`/api/blog/${slug}`)
      .then((res) => (res.ok ? res.text() : ''))
      .then(setContent)
      .catch(() => setContent(''))
  }, [slug])

  if (!meta) {
    return (
      <BlogLayout title="Post Not Found">
        <p>The requested blog post could not be found.</p>
      </BlogLayout>
    )
  }

  return (
    <BlogLayout title={meta.title} subtitle={meta.subtitle} date={meta.date}>
      {content === null ? (
        <p className="text-ink-muted">Loading...</p>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: content }} />
      )}
    </BlogLayout>
  )
}
