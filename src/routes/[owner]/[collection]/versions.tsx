import { Link, useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { TokenLink } from '~/lib/share-token'
import { useIsOwner } from '~/lib/use-is-owner'

import { CollectionNav, formatBytes } from '.'

export default function CollectionVersionsPage() {
  const { owner, collection } = useParams()
  const { data, versions } = useLoaderData() as { data: any; versions: any[] }

  const isOwner = useIsOwner(owner)

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={data.public}
          isOwner={!!isOwner}
          active="versions"
          version={versions[0]?.semver}
          isLatest
        />

        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-ink-muted text-sm font-semibold">
            {(data.versionCount ?? versions.length).toLocaleString()} version
            {(data.versionCount ?? versions.length) !== 1 ? 's' : ''}
            {data.versionCount > versions.length && (
              <span className="ml-1 font-normal">(showing latest {versions.length})</span>
            )}
          </h2>
          {versions.length > 1 && (
            <TokenLink
              to={`/${owner}/${collection}/diff`}
              className="text-link text-xs hover:underline"
            >
              Compare versions →
            </TokenLink>
          )}
        </div>

        {versions.length === 0 ? (
          <p className="text-ink-muted py-8 text-center text-sm">No versions yet.</p>
        ) : (
          <div className="border-rule overflow-hidden rounded border">
            {versions.map((v: any, i: number) => (
              <div
                key={v.semver}
                className={`hover:bg-parchment-dark/50 flex items-center justify-between px-4 py-3 transition-colors ${
                  i < versions.length - 1 ? 'border-rule border-b' : ''
                }`}
              >
                <TokenLink
                  to={`/${owner}/${collection}/v/${v.semver}`}
                  className="flex min-w-0 items-center gap-4"
                >
                  <div className="flex items-center gap-2">
                    <span className="bg-parchment-dark border-rule rounded border px-1.5 py-0.5 font-mono text-xs">
                      {v.semver}
                    </span>
                  </div>
                  {v.message && (
                    <span className="text-ink-muted truncate text-xs">{v.message}</span>
                  )}
                </TokenLink>
                <div className="text-ink-muted ml-4 flex shrink-0 items-center gap-5 text-xs">
                  <span>{v.recordCount.toLocaleString()} records</span>
                  <span>{v.fileCount.toLocaleString()} files</span>
                  <span>{formatBytes(v.totalBytes)}</span>
                  <span className="w-20 text-right">
                    {new Date(v.createdAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                  <code
                    className="text-ink-muted w-24 text-right font-mono text-[11px]"
                    title={`sha256:${v.hash}`}
                  >
                    {v.hash.slice(0, 10)}…
                  </code>
                  {v.ark && (
                    <Link
                      to={new URL(v.ark).pathname}
                      className="text-link font-mono text-[11px] hover:underline"
                    >
                      ark
                    </Link>
                  )}
                  {i < versions.length - 1 ? (
                    <TokenLink
                      to={`/${owner}/${collection}/diff?from=${versions[i + 1].semver}&to=${v.semver}`}
                      className="text-link w-8 text-right hover:underline"
                      title={`Diff ${versions[i + 1].semver} → ${v.semver}`}
                    >
                      diff
                    </TokenLink>
                  ) : (
                    <span className="w-8"></span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </BaseLayout>
  )
}
