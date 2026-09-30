import { useCallback, useEffect, useState } from 'react'

import { Button } from '~/components/ui'
import { authClient } from '~/lib/auth-client'
import { withToken } from '~/lib/share-token'

const VIEW_LINK_EXPIRES_SECONDS = 30 * 24 * 3600

export function SharePanel({
  owner,
  collection,
  collectionId,
  isPublic,
}: {
  owner: string
  collection: string
  collectionId: string
  isPublic: boolean
}) {
  const [modal, setModal] = useState<'view' | 'agent' | null>(null)
  const [viewUrl, setViewUrl] = useState<string | null>(null)
  const [agentUrl, setAgentUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState<'view' | 'agent' | null>(null)
  const [copied, setCopied] = useState<'link' | 'blurb' | null>(null)

  // Escape closes the share dialogs (backdrop click already does).
  useEffect(() => {
    if (!modal) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setModal(null)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [modal])

  const generateView = useCallback(async () => {
    setLoading('view')
    setCopied(null)
    try {
      const { data: keyData } = await authClient.apiKey.create({
        name: `share-${collection}`,
        metadata: {
          scope: 'read',
          collectionIds: [collectionId],
          linkShare: true,
        },
        expiresIn: VIEW_LINK_EXPIRES_SECONDS,
        prefix: 'ul',
      } as any)
      if (keyData) {
        setViewUrl(
          withToken(`${window.location.origin}/${owner}/${collection}`, (keyData as any).key),
        )
        setModal('view')
      }
    } finally {
      setLoading(null)
    }
  }, [owner, collection, collectionId])

  const generateAgent = useCallback(async () => {
    setLoading('agent')
    setCopied(null)
    try {
      const { data: keyData } = await authClient.apiKey.create({
        name: `agent-${collection}`,
        metadata: {
          scope: 'write',
          collectionIds: [collectionId],
          agentShare: true,
        },
        expiresIn: 3600,
        prefix: 'ul',
      } as any)
      if (keyData) {
        setAgentUrl(`${window.location.origin}/agent/${(keyData as any).key}`)
        setModal('agent')
      }
    } finally {
      setLoading(null)
    }
  }, [collection, collectionId])

  const copy = useCallback((text: string, which: 'link' | 'blurb') => {
    navigator.clipboard.writeText(text)
    setCopied(which)
    setTimeout(() => setCopied(null), 2000)
  }, [])

  const agentBlurb = agentUrl
    ? `Will you create an update that captures this conversation. Here is a link with reference how to do that: ${agentUrl}`
    : ''

  return (
    <>
      <div className="mb-6">
        <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">Share</h3>

        <div className="mb-3">
          <p className="text-ink-muted mb-1.5 text-xs leading-relaxed">
            {isPublic
              ? 'This collection is public — anyone with its URL can view it.'
              : 'Create a read-only link that lets anyone view this collection without signing in or becoming a member.'}
          </p>
          {isPublic ? (
            <Button
              variant="link"
              size="sm"
              className="font-medium"
              onClick={() => copy(`${window.location.origin}/${owner}/${collection}`, 'link')}
            >
              {copied === 'link' && modal === null ? 'Copied!' : 'Copy collection URL'}
            </Button>
          ) : (
            <Button
              variant="link"
              size="sm"
              className="font-medium"
              onClick={generateView}
              disabled={loading !== null}
            >
              {loading === 'view' ? 'Generating...' : 'Create view link →'}
            </Button>
          )}
        </div>

        <div>
          <p className="text-ink-muted mb-1.5 text-xs leading-relaxed">
            Or generate a temporary link that lets an AI agent push updates to this collection.
          </p>
          <Button
            variant="link"
            size="sm"
            className="font-medium"
            onClick={generateAgent}
            disabled={loading !== null}
          >
            {loading === 'agent' ? 'Generating...' : 'Generate agent link →'}
          </Button>
        </div>
      </div>

      {modal === 'view' && viewUrl && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null)
          }}
        >
          <div className="bg-parchment border-rule rounded-surface mx-4 w-full max-w-2xl border p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">View-only Link</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setModal(null)}
                className="text-ink-muted hover:text-ink cursor-pointer text-lg leading-none"
              >
                &times;
              </button>
            </div>

            <p className="text-ink-muted mb-4 text-xs leading-relaxed">
              Anyone with this link can browse this collection — overview, versions, records,
              schemas, and exports — without signing in. They cannot make changes. The link stays
              attached as they click between pages.
            </p>

            <div className="mb-4">
              <label className="text-ink-muted mb-1 block text-[11px] font-medium tracking-wide uppercase">
                Link
              </label>
              <div className="bg-parchment-dark border-rule rounded-surface border px-3 py-2 font-mono text-[11px] break-all">
                {viewUrl}
              </div>
              <Button size="sm" className="mt-2" onClick={() => copy(viewUrl, 'link')}>
                {copied === 'link' ? 'Copied!' : 'Copy link'}
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-ink-muted text-[10px]">
                Expires in 30 days. Revoke it anytime from Settings &rarr; API Keys.
              </p>
              <button
                onClick={() => {
                  setModal(null)
                  generateView()
                }}
                className="text-ink-muted text-xs underline hover:no-underline"
              >
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === 'agent' && agentUrl && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null)
          }}
        >
          <div className="bg-parchment border-rule rounded-surface mx-4 w-full max-w-2xl border p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Agent Update Link</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setModal(null)}
                className="text-ink-muted hover:text-ink cursor-pointer text-lg leading-none"
              >
                &times;
              </button>
            </div>

            <p className="text-ink-muted mb-4 text-xs leading-relaxed">
              This link gives an AI agent temporary write access to this collection (expires in 1
              hour). Paste the link or the prompt below into any AI chat. The agent will read the
              page to learn the collection&rsquo;s schema and push protocol, then write structured
              updates back.
            </p>

            <div className="mb-4">
              <label className="text-ink-muted mb-1 block text-[11px] font-medium tracking-wide uppercase">
                Link
              </label>
              <div className="bg-parchment-dark border-rule rounded-surface border px-3 py-2 font-mono text-[11px] break-all">
                {agentUrl}
              </div>
              <Button size="sm" className="mt-2" onClick={() => copy(agentUrl, 'link')}>
                {copied === 'link' ? 'Copied!' : 'Copy link'}
              </Button>
            </div>

            <div className="mb-4">
              <label className="text-ink-muted mb-1 block text-[11px] font-medium tracking-wide uppercase">
                Prompt
              </label>
              <div className="bg-parchment-dark border-rule rounded-surface overflow-hidden border px-3 py-2 text-xs leading-relaxed break-all">
                {agentBlurb}
              </div>
              <Button size="sm" className="mt-2" onClick={() => copy(agentBlurb, 'blurb')}>
                {copied === 'blurb' ? 'Copied!' : 'Copy prompt'}
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-ink-muted text-[10px]">Expires in 1 hour.</p>
              <button
                onClick={() => {
                  setModal(null)
                  generateAgent()
                }}
                className="text-ink-muted text-xs underline hover:no-underline"
              >
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
