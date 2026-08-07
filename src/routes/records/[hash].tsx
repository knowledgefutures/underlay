import { useMemo } from 'react'
import { Link, useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'

interface Reference {
  owner: string
  collection: string
  collectionName: string
  semver: string
  versionCreatedAt: string
}

interface RecordData {
  hash: string
  recordId: string
  type: string
  data: Record<string, unknown>
  size: number
  createdAt: string
  firstSeen: string
  references: Reference[]
}

function shortDate(d: string): string {
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export default function RecordDetailPage() {
  const params = useParams()
  const hash = params.hash!
  const record = useLoaderData() as RecordData

  const fields = Object.entries(record.data)

  // References arrive as one row per (collection, version); group per collection.
  const collections = useMemo(() => {
    const map = new Map<
      string,
      { owner: string; collection: string; collectionName: string; versions: Reference[] }
    >()
    for (const ref of record.references) {
      const key = `${ref.owner}/${ref.collection}`
      let entry = map.get(key)
      if (!entry) {
        entry = {
          owner: ref.owner,
          collection: ref.collection,
          collectionName: ref.collectionName,
          versions: [],
        }
        map.set(key, entry)
      }
      entry.versions.push(ref)
    }
    return [...map.values()]
  }, [record.references])

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-10">
        {/* Header */}
        <div className="mb-6">
          <div className="mb-2 flex items-center gap-3">
            <h1 className="font-mono text-lg font-semibold">{hash.slice(0, 16)}…</h1>
            <span className="border-rule text-ink-muted border px-1.5 py-0.5 text-xs">
              {record.type}
            </span>
          </div>
          <div className="text-ink-muted flex items-center gap-4 text-xs">
            <span>
              ID: <code className="font-mono">{record.recordId}</code>
            </span>
            <span>{record.size.toLocaleString()} bytes</span>
            <span>
              First seen{' '}
              {new Date(record.firstSeen).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
            <span>
              {collections.length} collection{collections.length !== 1 ? 's' : ''}
              {record.references.length > collections.length &&
                ` · ${record.references.length} versions`}
            </span>
          </div>
        </div>

        {/* Two-column layout: fields + JSON */}
        <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Fields table */}
          <div>
            <h2 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
              Fields
            </h2>
            <div className="border-rule overflow-hidden rounded border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-parchment-dark border-rule border-b">
                    <th className="p-2.5 text-left font-medium">Name</th>
                    <th className="p-2.5 text-left font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map(([name, val]) => (
                    <tr key={name} className="border-rule border-t">
                      <td className="p-2.5 font-mono font-medium">{name}</td>
                      <td className="max-w-md p-2.5">
                        <FieldValue name={name} value={val} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Raw JSON */}
          <div>
            <h2 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
              Canonical JSON
            </h2>
            <div className="border-rule overflow-hidden rounded border">
              <pre className="bg-ink text-parchment max-h-96 overflow-x-auto p-4 font-mono text-xs">
                <code>
                  {JSON.stringify(
                    { id: record.recordId, type: record.type, data: record.data },
                    null,
                    2,
                  )}
                </code>
              </pre>
            </div>
          </div>
        </div>

        {/* Provenance: which collections reference this record */}
        <div>
          <h2 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
            Appears in {collections.length} collection{collections.length !== 1 ? 's' : ''}
            {record.references.length > collections.length && (
              <span className="font-normal normal-case">
                {' '}
                · {record.references.length} versions
              </span>
            )}
          </h2>
          {collections.length === 0 ? (
            <p className="text-ink-muted py-4 text-sm">
              No public collections reference this record.
            </p>
          ) : (
            <div className="border-rule rounded-surface overflow-hidden border">
              {collections.map((c, i) => {
                const times = c.versions.map((v) => new Date(v.versionCreatedAt).getTime())
                const first = shortDate(new Date(Math.min(...times)).toISOString())
                const last = shortDate(new Date(Math.max(...times)).toISOString())
                return (
                  <div
                    key={`${c.owner}/${c.collection}`}
                    className={`px-4 py-3 ${i < collections.length - 1 ? 'border-rule border-b' : ''}`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <Link
                        to={`/${c.owner}/${c.collection}`}
                        className="min-w-0 truncate text-sm font-medium hover:underline"
                      >
                        {c.owner}/{c.collection}
                      </Link>
                      <span className="text-ink-muted shrink-0 text-xs">
                        {c.versions.length} version{c.versions.length !== 1 ? 's' : ''} ·{' '}
                        {first === last ? first : `${first} – ${last}`}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {c.versions.map((v) => (
                        <Link
                          key={v.semver}
                          to={`/${c.owner}/${c.collection}/v/${v.semver.replace(/^v/, '')}/records?type=${record.type}`}
                          title={shortDate(v.versionCreatedAt)}
                          className="border-rule text-link rounded-control hover:bg-parchment-dark border px-1.5 py-0.5 font-mono text-[11px] transition-colors"
                        >
                          {v.semver}
                        </Link>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Full hash */}
        <div className="border-rule mt-8 border-t pt-4">
          <p className="text-ink-muted text-xs">
            <span className="font-medium">Full hash:</span>
            <code className="ml-2 font-mono">{record.hash}</code>
          </p>
        </div>
      </div>
    </BaseLayout>
  )
}

function FieldValue({ name, value }: { name: string; value: unknown }) {
  if (value && typeof value === 'object' && '$file' in (value as any)) {
    const fileHash = ((value as any).$file as string).replace('sha256:', '')
    // Routes through the API so access is checked and a presigned URL is minted.
    const fileUrl = `/api/collections/files/${fileHash}`
    const label = name === 'pdf' ? 'PDF' : 'File'
    return (
      <a
        href={fileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link inline-flex items-center gap-1 hover:underline"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        {label}
      </a>
    )
  }

  if (typeof value === 'string' && value.match(/^https?:\/\//)) {
    return (
      <Link
        to={value}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link truncate hover:underline"
      >
        {value}
      </Link>
    )
  }

  if (Array.isArray(value)) {
    return <span className="text-ink-muted truncate">{JSON.stringify(value)}</span>
  }

  if (value === null || value === undefined) {
    return <span className="text-ink-muted italic">null</span>
  }

  if (typeof value === 'object') {
    return <span className="text-ink-muted truncate">{JSON.stringify(value)}</span>
  }

  return <span>{String(value)}</span>
}
