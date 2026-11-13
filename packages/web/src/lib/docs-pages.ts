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

/** A heading's anchor: what search links to, and the id DocsLayout gives an h2 without one. */
export const headingSlug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

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
        headings: ['Collection', 'Version', 'Record', 'File', 'Accounts', 'Privacy & Visibility'],
      },
      {
        title: 'Quickstart',
        href: '/docs/quickstart',
        blurb: 'Push your first version in 5 minutes',
        headings: [
          '1. Sign in and create an API key',
          '2. Create a collection',
          '3. Push a version',
          '4. Read it back',
          '5. Push an update',
          '6. Diff versions',
          'Record hashing',
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
          'Pushing a Full Export',
          'Record Hashing',
          'Record Format',
          'Metadata',
          'First Push Example',
          'Mapping a SQL Database',
          'Versioning',
          'Privacy',
          'API Reference',
          'Unknown Fields',
          'Error Handling',
          'Pushing from Scripts',
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
        headings: ['Base URL', 'Authentication', 'Rate Limits', 'Error Responses', 'Endpoints'],
      },
      {
        title: 'Accounts API',
        label: 'Accounts',
        href: '/docs/api/accounts',
        blurb: 'Profiles, organizations, API keys',
        headings: [
          'Authentication',
          'GET /api/accounts/me',
          'GET /api/accounts/:slug',
          'GET /api/accounts/:slug/members',
          'PUT /api/accounts/:slug/members/me',
          'PATCH /api/accounts/:slug',
          'DELETE /api/accounts/:slug',
          'POST /api/auth/organization/create',
          'POST /api/accounts/invitations/accept',
          'POST /api/auth/api-key/create',
          'GET /api/auth/api-key/list',
          'POST /api/auth/api-key/delete',
        ],
      },
      {
        title: 'Collections API',
        label: 'Collections',
        href: '/docs/api/collections',
        blurb: 'Create, list, update, delete, transfer, fork',
        headings: [
          'GET /api/collections',
          'POST /api/accounts/:owner/collections',
          'GET /api/collections/:owner/:slug',
          'PATCH /api/collections/:owner/:slug',
          'DELETE /api/collections/:owner/:slug',
          'GET /api/accounts/:owner/collections',
          'POST /api/collections/:owner/:slug/metadata',
          'POST /api/collections/:owner/:slug/transfer',
          'POST /api/collections/:owner/:slug/fork',
        ],
      },
      {
        title: 'Versions API',
        label: 'Versions',
        href: '/docs/api/versions',
        blurb: 'Delta push, version history, records, manifests, diff',
        headings: [
          'Delta push (open → upload → commit)',
          'GET /api/collections/:owner/:slug/push/:sid',
          'DELETE /api/collections/:owner/:slug/push/:sid',
          'GET /api/collections/:owner/:slug/versions',
          'GET /api/collections/:owner/:slug/versions/latest',
          'GET /api/collections/:owner/:slug/versions/:n',
          'GET /api/collections/:owner/:slug/versions/:n/records',
          'GET /api/collections/:owner/:slug/versions/:n/records/:type/:id',
          'GET /api/collections/:owner/:slug/records/:type/:id/history',
          'GET /api/collections/:owner/:slug/versions/:n/records.ndjson',
          'GET /api/collections/:owner/:slug/versions/:n/records.ndjson.gz',
          'GET /api/collections/:owner/:slug/versions/:n/manifest',
          'GET /api/collections/:owner/:slug/versions/:n/diff',
          'GET /api/collections/:owner/:slug/versions/:n/files',
        ],
      },
      {
        title: 'Files API',
        label: 'Files',
        href: '/docs/api/files',
        blurb: 'Upload, verify and download content-addressed files',
        headings: [
          'HEAD /api/collections/:owner/:slug/files/:hash',
          'GET /api/collections/:owner/:slug/files/:hash',
          'POST /api/collections/:owner/:slug/files/presign',
          'PUT /api/collections/:owner/:slug/files/:hash',
          'POST /api/collections/:owner/:slug/files/uploads',
          'GET /api/collections/:owner/:slug/files/uploads/:id/parts',
          'POST /api/collections/:owner/:slug/files/uploads/:id/complete',
          'GET /api/collections/:owner/:slug/files/uploads/:id',
          'File references in records',
        ],
      },
      {
        title: 'Records and schemas API',
        label: 'Records and schemas',
        href: '/docs/api/records',
        blurb: 'Schema discovery and labels',
        headings: [
          'Visibility',
          'GET /api/schemas',
          'GET /api/schemas/:id',
          'GET /api/collections/:owner/:slug/schemas',
          'POST /api/schemas/:id/labels',
          'DELETE /api/schemas/:id/labels/:label',
        ],
      },
      {
        title: 'Sync and integrations API',
        label: 'Sync and integrations',
        href: '/docs/api/sync-and-integrations',
        blurb: 'Exports, webhooks, ARKs, mirrors, health, abuse reports',
        headings: [
          'Tree sync',
          'Export',
          'Webhooks',
          'Webhook deliveries',
          'ARK identifiers',
          'Storage locations and mirrors',
          'Health',
          'Abuse reports',
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
        blurb: 'Protocol v3 (draft): scope, conformance, terminology, what is not available yet',
        headings: [
          'Conformance',
          'Terminology',
          'Properties',
          'Contents',
          'Not available yet',
          'Reference',
        ],
      },
      {
        title: 'Records and schemas',
        href: '/docs/protocol/records',
        blurb: 'Canonical JSON, record and removal lines, reserved types, input rules, schemas',
        headings: [
          'Canonical JSON',
          'Records and lines',
          'Reserved types',
          'Key order',
          'Input rules',
          'Schemas',
          'Validation',
          'Assets',
        ],
      },
      {
        title: 'Files and versions',
        href: '/docs/protocol/versions',
        blurb: 'Sorted-record-files, commits, version ids, signatures, semver, reading a version',
        headings: [
          'Sorted-record-files',
          'Entries',
          'Footer and file id',
          'Validity',
          'Commits',
          'Version id',
          'Base',
          'Signatures',
          'Naming a file',
          'Semver',
          'Reading a version',
        ],
      },
      {
        title: 'Layouts and collections',
        href: '/docs/protocol/repositories',
        blurb: 'Layout files, rebuilds, collections and forks, the reference server’s storage',
        headings: ['Layout files', 'Rebuilds', 'Collections', 'Reference server storage'],
      },
      {
        title: 'Push and pull',
        href: '/docs/protocol/push-and-pull',
        blurb: 'Making a commit on underlay.org, reading versions back, errors, security',
        headings: [
          'Delta push',
          'Clients without a copy',
          'Pull',
          'Errors',
          'Security considerations',
        ],
      },
    ],
  },
]
