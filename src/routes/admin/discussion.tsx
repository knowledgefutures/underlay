import { useCallback, useEffect, useState } from 'react'

import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'

interface PendingComment {
  id: string
  page: string
  anchor: string
  quote: string | null
  body: string
  createdAt: string
  authorName: string
  authorImage: string | null
}

interface Thread {
  id: string
  page: string
  anchor: string
  quote: string | null
  body: string
  status: string
  resolutionNote: string | null
  approvedAt: string | null
  createdAt: string
  authorName: string
}

export default function AdminDiscussion() {
  const { currentUser } = useAppContext()
  const [pending, setPending] = useState<PendingComment[]>([])
  const [threads, setThreads] = useState<Thread[]>([])
  const [loading, setLoading] = useState(true)

  const isSteward = currentUser?.kfRole === 'admin'

  const fetchData = useCallback(async () => {
    const res = await fetch('/api/admin/discussion')
    if (res.ok) {
      const data = await res.json()
      setPending(data.pending ?? [])
      setThreads(data.threads ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  async function handleApprove(id: string) {
    const comment = pending.find((c) => c.id === id)
    if (!comment) return
    await fetch(`/api/pages/${comment.page}/comments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    })
    fetchData()
  }

  async function handleDecline(id: string) {
    const comment = pending.find((c) => c.id === id)
    if (!comment) return
    await fetch(`/api/pages/${comment.page}/comments/${id}`, {
      method: 'DELETE',
    })
    fetchData()
  }

  if (!isSteward) {
    return (
      <BaseLayout>
        <div className="mx-auto max-w-2xl px-4 py-16 text-center">
          <p className="text-ink-muted text-sm">
            This page is only available to protocol stewards.
          </p>
        </div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-2 text-2xl font-semibold">Discussion Review</h1>
        <p className="text-ink-muted mb-8 text-sm">
          Review and moderate comments on the protocol specification.
        </p>

        {loading ? (
          <p className="text-ink-muted text-sm">Loading...</p>
        ) : (
          <>
            <section className="mb-10">
              <h2 className="mb-4 text-lg font-semibold">Pending review ({pending.length})</h2>
              {pending.length === 0 ? (
                <p className="text-ink-muted text-sm">No comments awaiting review.</p>
              ) : (
                <div className="space-y-3">
                  {pending.map((comment) => (
                    <div key={comment.id} className="border-rule rounded border p-4">
                      <div className="mb-2 flex items-center gap-2 text-xs">
                        <span className="font-medium">{comment.authorName}</span>
                        <span className="text-ink-muted">
                          {new Date(comment.createdAt).toLocaleString()}
                        </span>
                        <span className="text-ink-muted">on</span>
                        <span className="font-mono">
                          {comment.page}/{comment.anchor}
                        </span>
                      </div>
                      {comment.quote && (
                        <div className="border-rule mb-2 border-l-2 pl-2 text-xs text-amber-800 italic">
                          "{comment.quote}"
                        </div>
                      )}
                      <p className="mb-3 text-sm">{comment.body}</p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleApprove(comment.id)}
                          className="rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => handleDecline(comment.id)}
                          className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-4 text-lg font-semibold">All threads ({threads.length})</h2>
              {threads.length === 0 ? (
                <p className="text-ink-muted text-sm">No threads yet.</p>
              ) : (
                <div className="space-y-2">
                  {threads.map((thread) => (
                    <div
                      key={thread.id}
                      className="border-rule flex items-center gap-3 rounded border px-4 py-3"
                    >
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                          !thread.approvedAt
                            ? 'bg-yellow-100 text-yellow-800'
                            : thread.status === 'open'
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {!thread.approvedAt ? 'pending' : thread.status}
                      </span>
                      <span className="text-ink-muted font-mono text-xs">{thread.anchor}</span>
                      <span className="flex-1 truncate text-sm">{thread.body}</span>
                      <span className="text-ink-muted text-xs">{thread.authorName}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </BaseLayout>
  )
}
