import { useEffect, useRef, useState, } from 'react'
import { Link, } from 'react-router'

interface DocEntry {
  title: string
  href: string
  headings: string[]
}

const docs: DocEntry[] = [
  { title: 'Overview', href: '/docs', headings: ['Getting started', 'API reference', 'Self-hosting',], },
  { title: 'Concepts', href: '/docs/concepts', headings: ['Collection', 'Version', 'Record', 'File', 'Accounts',], },
  {
    title: 'Quickstart',
    href: '/docs/quickstart',
    headings: [
      'Sign in and create an API key',
      'Create a collection',
      'Push a version',
      'Read it back',
      'Push an update',
      'Diff versions',
      'Working with files',
      'Next steps',
    ],
  },
  {
    title: 'Integration Guide',
    href: '/docs/integration',
    headings: [
      'What is Underlay?',
      'Core Concepts',
      'Authentication',
      'The Push Flow',
      'Record Format',
      'First Push Example',
      'Mapping a SQL Database',
      'Versioning',
      'API Reference',
      'Error Handling',
      'Source Code',
    ],
  },
  {
    title: 'Self-hosting',
    href: '/docs/self-host',
    headings: [
      'Requirements',
      'Quick start with Docker',
      'Environment variables',
      'Production deployment',
      'Secrets management',
      'CI/CD',
      'Backups',
      'Reverse proxy',
    ],
  },
  {
    title: 'Accounts API',
    href: '/docs/api/accounts',
    headings: [
      'Authentication',
      'GET /api/accounts/me',
      'GET /api/accounts/:slug',
      'POST /api/accounts/keys',
      'GET /api/accounts/keys',
      'DELETE /api/accounts/keys/:id',
    ],
  },
  {
    title: 'Collections API',
    href: '/docs/api/collections',
    headings: [
      'GET /api/collections',
      'POST /api/accounts/:owner/collections',
      'GET /api/collections/:owner/:slug',
      'PATCH /api/collections/:owner/:slug',
      'DELETE /api/collections/:owner/:slug',
      'GET /api/accounts/:owner/collections',
    ],
  },
  {
    title: 'Versions API',
    href: '/docs/api/versions',
    headings: [
      'POST /api/collections/:owner/:slug/versions',
      'GET /api/collections/:owner/:slug/versions',
      'GET /api/collections/:owner/:slug/versions/latest',
      'GET /api/collections/:owner/:slug/versions/:n',
      'GET /api/collections/:owner/:slug/versions/:n/records',
      'GET /api/collections/:owner/:slug/versions/:n/manifest',
      'GET /api/collections/:owner/:slug/versions/:n/diff',
    ],
  },
  {
    title: 'Files API',
    href: '/docs/api/files',
    headings: [
      'HEAD /api/collections/:owner/:slug/files/:hash',
      'GET /api/collections/:owner/:slug/files/:hash',
      'PUT /api/collections/:owner/:slug/files/:hash',
      'File references in records',
    ],
  },
]

export default function DocsSearch() {
  const [query, setQuery,] = useState('',)
  const [showResults, setShowResults,] = useState(false,)
  const rootRef = useRef<HTMLDivElement>(null,)

  const q = query.trim().toLowerCase()

  const matches: { title: string; href: string; context?: string }[] = []
  if (q) {
    for (const doc of docs) {
      const titleMatch = doc.title.toLowerCase().includes(q,)
      const headingMatches = doc.headings.filter((h,) => h.toLowerCase().includes(q,))
      if (titleMatch) {
        matches.push({ title: doc.title, href: doc.href, },)
      }
      for (const h of headingMatches) {
        if (!titleMatch || headingMatches.length > 0) {
          const slug = h.toLowerCase().replace(/[^a-z0-9]+/g, '-',).replace(/(^-|-$)/g, '',)
          matches.push({ title: doc.title, href: `${doc.href}#${slug}`, context: h, },)
        }
      }
    }
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent,) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node,)) {
        setShowResults(false,)
      }
    }
    document.addEventListener('click', handleClickOutside,)
    return () => document.removeEventListener('click', handleClickOutside,)
  }, [],)

  function handleKeyDown(e: React.KeyboardEvent,) {
    if (e.key === 'Escape') {
      setShowResults(false,)
      ;(e.target as HTMLInputElement).blur()
    }
  }

  return (
    <div ref={rootRef} className='docs-search-box'>
      <input
        type='text'
        placeholder='Search docs...'
        autoComplete='off'
        className='w-full border border-rule bg-parchment px-2.5 py-1.5 text-xs placeholder:text-ink-muted/50 focus:outline-none focus:border-ink-muted'
        value={query}
        onChange={(e,) => {
          setQuery(e.target.value,)
          setShowResults(true,)
        }}
        onKeyDown={handleKeyDown}
      />
      {showResults && q && (
        <div id='docs-search-results'>
          {matches.length === 0 ? <div className='docs-search-empty'>No results</div> : (
            matches.slice(0, 12,).map((m, i,) => (
              <Link key={i} to={m.href} className='docs-search-result'>
                <span className='docs-search-result-title'>{m.title}</span>
                {m.context && <span className='docs-search-result-context'>{m.context}</span>}
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  )
}
