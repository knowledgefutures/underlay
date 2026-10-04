import { type FormEvent, useState } from 'react'

import BaseLayout from '~/components/BaseLayout'
import { Alert, Button, Field, Input } from '~/components/ui'

/** Report a file or record that shouldn't be served (POST /api/abuse-reports). */
export default function Report() {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const [hash, setHash] = useState(params.get('hash') ?? '')
  const [url, setUrl] = useState(params.get('url') ?? '')
  const [reason, setReason] = useState('')
  const [contact, setContact] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const res = await fetch('/api/abuse-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          hash: hash.trim(),
          url: url.trim(),
          reason,
          contact: contact.trim(),
        }),
      })
      if (res.ok) setSent(true)
      else setError((await res.json().catch(() => null))?.error ?? 'The report could not be sent.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-lg px-4 py-10">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Report content</h1>
        <p className="text-ink-muted mb-6 text-sm">
          Tell us about a file or record on Underlay that is malicious, infringing or unlawful. A
          steward reviews every report, and blocked content stops being served at once.
        </p>
        {sent ? (
          <Alert variant="success">Thank you. Your report has been sent to the stewards.</Alert>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <Alert variant="error">{error}</Alert>}
            <Field
              label="Link"
              htmlFor="reportUrl"
              hint="The page or download link, if you have it."
            >
              <Input id="reportUrl" value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Field
              label="Hash"
              htmlFor="reportHash"
              hint="The file or record hash (64 hex characters), if you have it."
            >
              <Input
                id="reportHash"
                value={hash}
                onChange={(e) => setHash(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="What is wrong" htmlFor="reportReason">
              <textarea
                id="reportReason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                rows={5}
                className="border-rule rounded-control w-full border px-3 py-2 text-sm"
              />
            </Field>
            <Field
              label="Your email"
              htmlFor="reportContact"
              hint="Optional, if you'd like a reply."
            >
              <Input
                id="reportContact"
                type="email"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              disabled={submitting || !reason.trim() || (!hash.trim() && !url.trim())}
            >
              {submitting ? 'Sending…' : 'Send report'}
            </Button>
          </form>
        )}
      </div>
    </BaseLayout>
  )
}
