/** Blog post metadata; bodies live in content/blog/<slug>.md. Listed newest first. */
export interface BlogPost {
  slug: string
  title: string
  subtitle: string
  date: string
}

export const blogPosts: BlogPost[] = [
  {
    slug: '2026-06-08-permanently-addressable-structured-data',
    title: 'Permanently Addressable Structured Data',
    subtitle: 'What Underlay is, why it matters now, and how it works.',
    date: '2026-06-08',
  },
  {
    slug: '2026-06-08-content-addressed-records',
    title: 'Content-Addressed Records',
    subtitle:
      'Applying the insight that already works for schemas and files to the records themselves.',
    date: '2026-06-08',
  },
  {
    slug: '2026-04-30-schema-evolution',
    title: 'Schema Evolution',
    subtitle: 'How Underlay handles schema changes across versions.',
    date: '2026-04-30',
  },
  {
    slug: '2026-04-28-atproto-integration',
    title: 'AT Protocol Integration',
    subtitle: 'Connecting Underlay to the decentralized social web.',
    date: '2026-04-28',
  },
  {
    slug: '2024-04-27-institutional-repositories',
    title: 'Institutional Repositories',
    subtitle: 'Why universities need better infrastructure for structured data.',
    date: '2024-04-27',
  },
  {
    slug: '2024-04-27-underlay-revived',
    title: 'Underlay, Revived',
    subtitle: 'The landscape changed. The project can finally be simple.',
    date: '2024-04-27',
  },
]

export const blogPostsBySlug: Record<string, BlogPost> = Object.fromEntries(
  blogPosts.map((p) => [p.slug, p]),
)
