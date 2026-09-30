import type { LoaderFunctionArgs } from 'react-router'

import { blogPostsBySlug as posts } from '~/lib/blog-posts'
import { fetchBase } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) => {
    const post = params.slug ? posts[params.slug] : undefined
    return post ? `${post.title} · Underlay` : 'Blog · Underlay'
  },
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const res = await fetch(new URL(`/api/blog/${params.slug}`, base))
  return { content: res.ok ? await res.text() : '' }
}
