import { useLoaderData, useParams } from 'react-router'

import BlogLayout from '~/components/BlogLayout'

import { posts } from './[slug].data'

export default function BlogPost() {
  const { slug } = useParams()
  const { content } = useLoaderData() as { content: string }

  const meta = slug ? posts[slug] : undefined

  if (!meta) {
    return (
      <BlogLayout title="Post Not Found">
        <p>The requested blog post could not be found.</p>
      </BlogLayout>
    )
  }

  return (
    <BlogLayout title={meta.title} subtitle={meta.subtitle} date={meta.date}>
      {content ? (
        <div dangerouslySetInnerHTML={{ __html: content }} />
      ) : (
        <p className="text-ink-muted">Post content unavailable.</p>
      )}
    </BlogLayout>
  )
}
