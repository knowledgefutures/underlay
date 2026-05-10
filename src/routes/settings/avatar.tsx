import { useState, type FormEvent } from 'react'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData } from '~/lib/ssr-data'

export default function SettingsAvatar() {
  const me = useSSRData<any>('currentUser')

  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState(me?.avatarUrl ?? '')

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

  if (!me) return null

  return (
    <BaseLayout>
      <div className="max-w-4xl mx-auto px-4 py-10">
        <h1 className="text-xl font-semibold tracking-tight mb-6">Settings</h1>

        <nav className="flex gap-4 text-sm border-b border-rule mb-6 pb-2">
          <a href="/settings" className="text-ink-muted hover:text-ink">Account</a>
          <a href="/settings/keys" className="text-ink-muted hover:text-ink">API Keys</a>
          <a href="/settings/sessions" className="text-ink-muted hover:text-ink">Sessions</a>
        </nav>

        <nav className="text-xs text-ink-muted mb-6">
          <a href="/settings" className="hover:text-ink">Account</a>
          <span className="mx-1">/</span>
          <span className="text-ink font-medium">Avatar</span>
        </nav>

        {success && <p className="text-sm text-green-800 bg-green-50 border border-green-200 px-3 py-2 mb-4">{success}</p>}
        {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 mb-4">{error}</p>}

        <div className="border border-rule p-6">
          <h2 className="text-sm font-semibold mb-4">Upload Avatar</h2>

          <div className="flex items-center gap-6 mb-6">
            {avatarUrl ? (
              <img src={avatarUrl} alt="Current avatar" className="w-24 h-24 rounded-full object-cover border border-rule" />
            ) : (
              <div className="w-24 h-24 rounded-full bg-parchment-dark border border-rule flex items-center justify-center text-ink-muted text-2xl font-semibold">
                {me.displayName?.charAt(0)?.toUpperCase() ?? '?'}
              </div>
            )}
            <div className="text-sm text-ink-muted">
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
                className="text-sm file:mr-3 file:px-3 file:py-1.5 file:border file:border-rule file:bg-parchment file:text-sm file:font-medium file:cursor-pointer hover:file:bg-parchment-dark"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
            >
              {submitting ? 'Uploading…' : 'Upload'}
            </button>
          </form>
        </div>
      </div>
    </BaseLayout>
  )
}
