import { type FormEvent, useState } from 'react'
import { Link, Navigate } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'

export const handle = { title: 'Avatar — Underlay', requireAuth: true }

export default function SettingsAvatar() {
  const { currentUser } = useAppContext()

  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState(currentUser?.avatarUrl ?? '')

  async function handleUpload(e: FormEvent) {
    e.preventDefault()
    setSuccess('')
    setError('')

    const form = e.target as HTMLFormElement
    const fileInput = form.elements.namedItem('avatar') as HTMLInputElement
    const file = fileInput?.files?.[0]

    if (!file) {
      setError('Please select a file.')
      return
    }

    setSubmitting(true)
    try {
      const formData = new FormData()
      formData.append('avatar', file)

      const res = await fetch('/api/accounts/me/avatar', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })

      if (res.ok) {
        const data = await res.json()
        setSuccess('Avatar updated.')
        setAvatarUrl(data.avatarUrl)
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Upload failed.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (!currentUser) return <Navigate to="/login" replace />

  return (
    <BaseLayout>
      <div className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Settings</h1>

        <nav className="border-rule mb-6 flex gap-4 border-b pb-2 text-sm">
          <Link to="/settings" className="text-ink-muted hover:text-ink">
            Account
          </Link>
          <Link to="/settings/keys" className="text-ink-muted hover:text-ink">
            API Keys
          </Link>
          <Link to="/settings/sessions" className="text-ink-muted hover:text-ink">
            Sessions
          </Link>
        </nav>

        <nav className="text-ink-muted mb-6 text-xs">
          <Link to="/settings" className="hover:text-ink">
            Account
          </Link>
          <span className="mx-1">/</span>
          <span className="text-ink font-medium">Avatar</span>
        </nav>

        {success && (
          <p className="mb-4 border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            {success}
          </p>
        )}
        {error && (
          <p className="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="border-rule border p-6">
          <h2 className="mb-4 text-sm font-semibold">Upload Avatar</h2>

          <div className="mb-6 flex items-center gap-6">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="Current avatar"
                className="border-rule h-24 w-24 rounded-full border object-cover"
              />
            ) : (
              <div className="bg-parchment-dark border-rule text-ink-muted flex h-24 w-24 items-center justify-center rounded-full border text-2xl font-semibold">
                {currentUser.displayName?.charAt(0)?.toUpperCase() ?? '?'}
              </div>
            )}
            <div className="text-ink-muted text-sm">
              <p>Accepted formats: JPEG, PNG, GIF, WebP</p>
              <p>Maximum size: 5 MB</p>
            </div>
          </div>

          <form onSubmit={handleUpload} className="space-y-4">
            <div>
              <input
                type="file"
                name="avatar"
                accept="image/jpeg,image/png,image/gif,image/webp"
                className="file:border-rule file:bg-parchment hover:file:bg-parchment-dark text-sm file:mr-3 file:cursor-pointer file:border file:px-3 file:py-1.5 file:text-sm file:font-medium"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="bg-ink text-parchment px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
            >
              {submitting ? 'Uploading…' : 'Upload'}
            </button>
          </form>
        </div>
      </div>
    </BaseLayout>
  )
}
