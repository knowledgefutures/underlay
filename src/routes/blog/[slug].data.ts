import type { LoaderFunctionArgs } from 'react-router'

export const posts: Record<string, { title: string; subtitle: string; date: string }> = {
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
  '2026-06-08-content-addressed-records': {
    title: 'Content-Addressed Records',
    subtitle:
      'Applying the insight that already works for schemas and files to the records themselves.',
    date: '2026-06-08',
  },
  '2026-06-08-permanently-addressable-structured-data': {
    title: 'Permanently Addressable Structured Data',
    subtitle: 'What Underlay is, why it matters now, and how it works.',
    date: '2026-06-08',
  },
}

export const handle = {
  title: (params: Record<string, string>) => {
    const post = params.slug ? posts[params.slug] : undefined
    return post ? `${post.title} · Underlay` : 'Blog · Underlay'
  },
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = new URL(request.url).origin
  const res = await fetch(new URL(`/api/blog/${params.slug}`, base))
  return { content: res.ok ? await res.text() : '' }
}
