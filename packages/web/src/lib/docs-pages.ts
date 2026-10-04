/**
 * The docs' pages, in nav order: the sidebar (DocsLayout), search (DocsSearch)
 * and the docs index all read this one list. `headings` are the page's h2s,
 * which search links to by their slugified anchors.
 */
export interface DocPage {
  title: string
  /** The sidebar label, when shorter than the title. */
  label?: string
  href: string
  /** One line for the docs index. */
  blurb: string
  headings: string[]
}

export const docSections: { section: string; pages: DocPage[] }[] = [
  {
    section: 'Getting started',
    pages: [
      {
        title: 'Overview',
        href: '/docs',
        blurb: 'Where to start',
        headings: ['Getting started', 'API reference', 'Protocol'],
      },
      {
        title: 'Concepts',
        href: '/docs/concepts',
        blurb: 'Collections, versions, records, files',
        headings: ['Collection', 'Version', 'Record', 'File', 'Accounts'],
      },
      {
        title: 'Quickstart',
        href: '/docs/quickstart',
        blurb: 'Push your first version in 5 minutes',
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
        blurb: 'Push data from any app, no SDK',
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
    ],
  },
  {
    section: 'API reference',
    pages: [
      {
        title: 'API Overview',
        label: 'Overview',
        href: '/docs/api',
        blurb: 'Auth, rate limits, error handling',
        headings: [],
      },
      {
        title: 'Accounts API',
        label: 'Accounts',
        href: '/docs/api/accounts',
        blurb: 'Signup, login, API keys',
        headings: [
          'Authentication',
          'GET /api/accounts/me',
          'GET /api/accounts/:slug',
          'POST /api/auth/api-key/create',
          'GET /api/auth/api-key/list',
          'POST /api/auth/api-key/delete',
        ],
      },
      {
        title: 'Collections API',
        label: 'Collections',
        href: '/docs/api/collections',
        blurb: 'Create, list, update, delete',
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
        label: 'Versions',
        href: '/docs/api/versions',
        blurb: 'Push snapshots, browse history, diff',
        headings: [
          'POST /api/collections/:owner/:slug/versions/negotiate',
          'POST /api/.../negotiate/:sessionId/records',
          'POST /api/.../negotiate/:sessionId/commit',
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
        label: 'Files',
        href: '/docs/api/files',
        blurb: 'Upload and download content-addressed files',
        headings: [
          'HEAD /api/collections/:owner/:slug/files/:hash',
          'GET /api/collections/:owner/:slug/files/:hash',
          'PUT /api/collections/:owner/:slug/files/:hash',
          'File references in records',
        ],
      },
    ],
  },
  {
    section: 'Protocol',
    pages: [
      {
        title: 'Protocol',
        label: 'Overview',
        href: '/docs/protocol',
        blurb: 'Protocol v2: what is content-addressed, and what it guarantees',
        headings: ['Primitives', 'What it guarantees', 'In this section', 'Reference'],
      },
      {
        title: 'Records and schemas',
        href: '/docs/protocol/records',
        blurb: 'Canonical JSON, record and schema hashes, input rules, validation',
        headings: ['Canonical JSON', 'Records', 'Input rules', 'Schemas', 'Validation', 'Files'],
      },
      {
        title: 'Trees and versions',
        href: '/docs/protocol/versions',
        blurb: 'Record trees, public and private sets, the version root, semver',
        headings: ['Key order', 'Trees', 'Access sets', 'Version root', 'Semver'],
      },
      {
        title: 'Repositories',
        href: '/docs/protocol/repositories',
        blurb: 'The bucket layout, the signed version log, packs for sync',
        headings: ['Layout', 'Version log', 'Sync'],
      },
      {
        title: 'Push and pull',
        href: '/docs/protocol/push-and-pull',
        blurb: 'Delta push, negotiate, pull, and v1 compatibility',
        headings: ['Delta push', 'Negotiate (compatibility)', 'Pull', 'v1 hashes', 'Errors'],
      },
    ],
  },
]
