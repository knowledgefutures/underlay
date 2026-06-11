import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppContext } from '~/lib/app-context'

interface Comment {
  id: string
  anchor: string
  quote: string | null
  quoteContext: { prefix: string; suffix: string } | null
  parentId: string | null
  userId: string
  body: string
  approvedAt: string | null
  status: 'open' | 'answered' | 'decided' | 'changed'
  resolutionNote: string | null
  createdAt: string
  editedAt: string | null
  authorName: string
  authorImage: string | null
}

interface DiscussionDrawerProps {
  page: string
  anchor: string | null
  quote?: string | null
  quoteContext?: { prefix: string; suffix: string } | null
  comments: Record<string, Comment[]>
  onClose: () => void
  onRefresh: () => void
  isSteward: boolean
}

export default function DiscussionDrawer({
  page,
  anchor,
  quote: initialQuote,
  quoteContext: initialQuoteContext,
  comments,
  onClose,
  onRefresh,
  isSteward,
}: DiscussionDrawerProps) {
  const { currentUser } = useAppContext()
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [resolveId, setResolveId] = useState<string | null>(null)
  const [resolveStatus, setResolveStatus] = useState<'answered' | 'decided' | 'changed'>('answered')
  const [resolveNote, setResolveNote] = useState('')
  const [showClosed, setShowClosed] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)

  const anchorComments = useMemo(() => (anchor ? (comments[anchor] ?? []) : []), [anchor, comments])
  const threads = anchorComments.filter((c) => !c.parentId)
  const openThreads = threads.filter((t) => t.status === 'open')
  const closedThreads = threads.filter((t) => t.status !== 'open')

  const getReplies = useCallback(
    (parentId: string) => anchorComments.filter((c) => c.parentId === parentId),
    [anchorComments],
  )

  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [onClose])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim() || !anchor) return
    setSubmitting(true)
    try {
      const payload: Record<string, any> = { anchor, body: body.trim() }
      if (initialQuote) {
        payload.quote = initialQuote
        if (initialQuoteContext) payload.quoteContext = initialQuoteContext
      }
      const res = await fetch(`/api/pages/${page}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        setBody('')
        onRefresh()
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleReply(e: React.FormEvent) {
    e.preventDefault()
    if (!replyBody.trim() || !replyTo || !anchor) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/pages/${page}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchor, body: replyBody.trim(), parentId: replyTo }),
      })
      if (res.ok) {
        setReplyBody('')
        setReplyTo(null)
        onRefresh()
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleApprove(commentId: string) {
    await fetch(`/api/pages/${page}/comments/${commentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    })
    onRefresh()
  }

  async function handleDecline(commentId: string) {
    await fetch(`/api/pages/${page}/comments/${commentId}`, {
      method: 'DELETE',
    })
    onRefresh()
  }

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault()
    if (!resolveId) return
    await fetch(`/api/pages/${page}/comments/${resolveId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: resolveStatus, resolutionNote: resolveNote || undefined }),
    })
    setResolveId(null)
    setResolveNote('')
    onRefresh()
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  const statusLabel: Record<string, string> = {
    answered: 'Answered',
    decided: 'Decided',
    changed: 'Changed',
  }

  const statusColor: Record<string, string> = {
    answered: 'bg-blue-100 text-blue-800',
    decided: 'bg-amber-100 text-amber-800',
    changed: 'bg-green-100 text-green-800',
  }

  if (!anchor) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div
        ref={drawerRef}
        className="bg-parchment border-rule relative z-10 flex h-full w-full max-w-md flex-col border-l shadow-lg"
      >
        <div className="border-rule flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold">
            Discussion: <span className="font-mono text-xs">{anchor}</span>
          </h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink text-lg leading-none">
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {initialQuote && (
            <div className="border-rule bg-parchment-dark mb-4 rounded border-l-2 px-3 py-2 text-xs italic">
              "{initialQuote}"
            </div>
          )}

          {openThreads.length === 0 && closedThreads.length === 0 && (
            <p className="text-ink-muted py-8 text-center text-sm">
              No discussion yet.{' '}
              {currentUser ? 'Start the conversation below.' : 'Log in to comment.'}
            </p>
          )}

          {openThreads.map((thread) => (
            <ThreadView
              key={thread.id}
              thread={thread}
              replies={getReplies(thread.id)}
              currentUserId={currentUser?.id}
              isSteward={isSteward}
              replyTo={replyTo}
              replyBody={replyBody}
              submitting={submitting}
              resolveId={resolveId}
              resolveStatus={resolveStatus}
              resolveNote={resolveNote}
              formatDate={formatDate}
              statusLabel={statusLabel}
              statusColor={statusColor}
              onReplyTo={setReplyTo}
              onReplyBody={setReplyBody}
              onReplySubmit={handleReply}
              onApprove={handleApprove}
              onDecline={handleDecline}
              onResolveStart={(id) => {
                setResolveId(id)
                setResolveStatus('answered')
                setResolveNote('')
              }}
              onResolveStatusChange={setResolveStatus}
              onResolveNoteChange={setResolveNote}
              onResolveSubmit={handleResolve}
              onResolveCancel={() => setResolveId(null)}
            />
          ))}

          {closedThreads.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowClosed(!showClosed)}
                className="text-ink-muted hover:text-ink mb-2 text-xs"
              >
                {showClosed ? 'Hide' : 'Show'} closed ({closedThreads.length})
              </button>
              {showClosed &&
                closedThreads.map((thread) => (
                  <ThreadView
                    key={thread.id}
                    thread={thread}
                    replies={getReplies(thread.id)}
                    currentUserId={currentUser?.id}
                    isSteward={isSteward}
                    replyTo={replyTo}
                    replyBody={replyBody}
                    submitting={submitting}
                    resolveId={resolveId}
                    resolveStatus={resolveStatus}
                    resolveNote={resolveNote}
                    formatDate={formatDate}
                    statusLabel={statusLabel}
                    statusColor={statusColor}
                    onReplyTo={setReplyTo}
                    onReplyBody={setReplyBody}
                    onReplySubmit={handleReply}
                    onApprove={handleApprove}
                    onDecline={handleDecline}
                    onResolveStart={(id) => {
                      setResolveId(id)
                      setResolveStatus('answered')
                      setResolveNote('')
                    }}
                    onResolveStatusChange={setResolveStatus}
                    onResolveNoteChange={setResolveNote}
                    onResolveSubmit={handleResolve}
                    onResolveCancel={() => setResolveId(null)}
                  />
                ))}
            </div>
          )}
        </div>

        {currentUser && (
          <div className="border-rule border-t px-4 py-3">
            <form onSubmit={handleSubmit}>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Leave a comment..."
                rows={3}
                maxLength={8192}
                className="border-rule bg-parchment w-full resize-none rounded border px-3 py-2 text-sm focus:outline-none"
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-ink-muted text-xs">Markdown supported</span>
                <button
                  type="submit"
                  disabled={!body.trim() || submitting}
                  className="bg-ink text-parchment hover:bg-ink/80 disabled:bg-ink/40 rounded px-3 py-1 text-xs font-medium transition-colors"
                >
                  {submitting ? 'Submitting...' : 'Comment'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}

interface ThreadViewProps {
  thread: Comment
  replies: Comment[]
  currentUserId?: string
  isSteward: boolean
  replyTo: string | null
  replyBody: string
  submitting: boolean
  resolveId: string | null
  resolveStatus: 'answered' | 'decided' | 'changed'
  resolveNote: string
  formatDate: (iso: string) => string
  statusLabel: Record<string, string>
  statusColor: Record<string, string>
  onReplyTo: (id: string | null) => void
  onReplyBody: (body: string) => void
  onReplySubmit: (e: React.FormEvent) => void
  onApprove: (id: string) => void
  onDecline: (id: string) => void
  onResolveStart: (id: string) => void
  onResolveStatusChange: (status: 'answered' | 'decided' | 'changed') => void
  onResolveNoteChange: (note: string) => void
  onResolveSubmit: (e: React.FormEvent) => void
  onResolveCancel: () => void
}

function ThreadView({
  thread,
  replies,
  currentUserId,
  isSteward,
  replyTo,
  replyBody,
  submitting,
  resolveId,
  resolveStatus,
  resolveNote,
  formatDate,
  statusLabel,
  statusColor,
  onReplyTo,
  onReplyBody,
  onReplySubmit,
  onApprove,
  onDecline,
  onResolveStart,
  onResolveStatusChange,
  onResolveNoteChange,
  onResolveSubmit,
  onResolveCancel,
}: ThreadViewProps) {
  const isPending = !thread.approvedAt
  const isClosed = thread.status !== 'open'

  return (
    <div className={`border-rule mb-3 rounded border p-3 ${isClosed ? 'opacity-70' : ''}`}>
      {thread.quote && (
        <div className="border-rule mb-2 border-l-2 pl-2 text-xs text-amber-800 italic">
          "{thread.quote}"
        </div>
      )}

      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-medium">{thread.authorName}</span>
        <span className="text-ink-muted text-xs">{formatDate(thread.createdAt)}</span>
        {isPending && (
          <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-800">
            Awaiting review
          </span>
        )}
        {isClosed && thread.status && (
          <span className={`rounded px-1.5 py-0.5 text-xs ${statusColor[thread.status] ?? ''}`}>
            {statusLabel[thread.status] ?? thread.status}
          </span>
        )}
      </div>

      <div className="prose prose-sm mb-2 text-sm">{thread.body}</div>

      {thread.resolutionNote && (
        <div className="border-rule mt-2 rounded border bg-gray-50 px-2 py-1.5 text-xs">
          <span className="font-medium">Resolution:</span> {thread.resolutionNote}
        </div>
      )}

      {isSteward && isPending && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => onApprove(thread.id)}
            className="rounded bg-green-600 px-2 py-0.5 text-xs text-white hover:bg-green-700"
          >
            Approve
          </button>
          <button
            onClick={() => onDecline(thread.id)}
            className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
          >
            Decline
          </button>
        </div>
      )}

      {replies.map((reply) => (
        <div key={reply.id} className="border-rule mt-2 border-l-2 pl-3">
          <div className="mb-0.5 flex items-center gap-2">
            <span className="text-xs font-medium">{reply.authorName}</span>
            <span className="text-ink-muted text-xs">{formatDate(reply.createdAt)}</span>
            {!reply.approvedAt && (
              <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-800">
                Awaiting review
              </span>
            )}
          </div>
          <div className="text-sm">{reply.body}</div>
          {isSteward && !reply.approvedAt && (
            <div className="mt-1 flex gap-2">
              <button
                onClick={() => onApprove(reply.id)}
                className="rounded bg-green-600 px-2 py-0.5 text-xs text-white hover:bg-green-700"
              >
                Approve
              </button>
              <button
                onClick={() => onDecline(reply.id)}
                className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
              >
                Decline
              </button>
            </div>
          )}
        </div>
      ))}

      {!isClosed && thread.approvedAt && (
        <div className="mt-2 flex gap-2">
          {currentUserId && replyTo !== thread.id && (
            <button
              onClick={() => onReplyTo(thread.id)}
              className="text-ink-muted hover:text-ink text-xs"
            >
              Reply
            </button>
          )}
          {isSteward && resolveId !== thread.id && (
            <button
              onClick={() => onResolveStart(thread.id)}
              className="text-ink-muted hover:text-ink text-xs"
            >
              Resolve
            </button>
          )}
        </div>
      )}

      {replyTo === thread.id && (
        <form onSubmit={onReplySubmit} className="mt-2">
          <textarea
            value={replyBody}
            onChange={(e) => onReplyBody(e.target.value)}
            placeholder="Write a reply..."
            rows={2}
            maxLength={8192}
            className="border-rule bg-parchment w-full resize-none rounded border px-2 py-1.5 text-sm focus:outline-none"
          />
          <div className="mt-1 flex gap-2">
            <button
              type="submit"
              disabled={!replyBody.trim() || submitting}
              className="bg-ink text-parchment hover:bg-ink/80 disabled:bg-ink/40 rounded px-2 py-0.5 text-xs font-medium"
            >
              Reply
            </button>
            <button
              type="button"
              onClick={() => onReplyTo(null)}
              className="text-ink-muted text-xs"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {resolveId === thread.id && (
        <form onSubmit={onResolveSubmit} className="border-rule mt-2 rounded border bg-gray-50 p-2">
          <div className="mb-2 flex gap-2">
            {(['answered', 'decided', 'changed'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onResolveStatusChange(s)}
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  resolveStatus === s
                    ? 'bg-ink text-parchment'
                    : 'bg-parchment text-ink border-rule border'
                }`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={resolveNote}
            onChange={(e) => onResolveNoteChange(e.target.value)}
            placeholder="Resolution note (optional)"
            className="border-rule bg-parchment w-full rounded border px-2 py-1 text-sm focus:outline-none"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="submit"
              className="bg-ink text-parchment hover:bg-ink/80 rounded px-2 py-0.5 text-xs font-medium"
            >
              Close thread
            </button>
            <button type="button" onClick={onResolveCancel} className="text-ink-muted text-xs">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
