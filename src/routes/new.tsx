import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'

export default function NewCollection() {
  const { currentUser } = useAppContext()
  const navigate = useNavigate()

  const ownerOptions = (currentUser?.orgs ?? []).map((o: any) => ({
    slug: o.slug,
    label: `${o.name ?? o.displayName ?? o.slug}${o.isDefault ? ' (personal)' : ''}`,
  }))
  const defaultOwner = currentUser?.orgs?.find((o: any) => o.isDefault) ?? currentUser?.orgs?.[0]

  const [owner, setOwner] = useState(defaultOwner?.slug ?? '')
  const [slug, setSlug] = useState('')

  function slugify(value: string) {
    return value
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-{2,}/g, '-')
  }
  const [isPublic, setIsPublic] = useState(false)
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const res = await fetch(`/api/accounts/${owner}/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          slug,
          name: slug,
          public: isPublic,
          description: description || undefined,
        }),
      })
      if (res.ok) {
        navigate(`/${owner}/${slug}`)
      } else {
        const err = await res.json()
        setError(err.error ?? 'Failed to create collection')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-lg px-4 py-10">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Create a new collection</h1>
        <p className="text-ink-muted mb-8 text-sm">
          A collection holds versioned, structured data. You can push records via the API or CLI.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          {/* Owner */}
          <div>
            <label className="text-ink mb-1.5 block text-sm font-medium">Owner</label>
            {ownerOptions.length > 1 ? (
              <select
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                className="bg-parchment border-rule focus:border-ink w-full rounded border px-3 py-2 text-sm focus:outline-none"
              >
                {ownerOptions.map((o: any) => (
                  <option key={o.slug} value={o.slug}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="bg-parchment-dark border-rule rounded border px-3 py-2 text-sm">
                {ownerOptions[0]?.label ?? owner}
              </div>
            )}
          </div>

          {/* Slug */}
          <div>
            <label className="text-ink mb-1.5 block text-sm font-medium">Collection name</label>
            <input
              type="text"
              required
              pattern="[a-z0-9][-a-z0-9]*[a-z0-9]"
              minLength={2}
              placeholder="my-dataset"
              value={slug}
              onChange={(e) => setSlug(slugify(e.target.value))}
              className="bg-parchment border-rule focus:border-ink w-full rounded border px-3 py-2 text-sm focus:outline-none"
            />
            <p className="text-ink-muted mt-1 text-xs">
              Lowercase letters, numbers, and hyphens. This becomes the URL:{' '}
              <span className="font-mono">
                {owner}/{slug || '...'}
              </span>
            </p>
          </div>

          {/* Description */}
          <div>
            <label className="text-ink mb-1.5 block text-sm font-medium">
              Description <span className="text-ink-muted font-normal">(optional)</span>
            </label>
            <input
              type="text"
              placeholder="A short description of this collection"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="bg-parchment border-rule focus:border-ink w-full rounded border px-3 py-2 text-sm focus:outline-none"
            />
          </div>

          {/* Visibility */}
          <fieldset>
            <legend className="text-ink mb-2 text-sm font-medium">Visibility</legend>
            <div className="space-y-2">
              <label className="flex items-start gap-2.5">
                <input
                  type="radio"
                  name="visibility"
                  checked={!isPublic}
                  onChange={() => setIsPublic(false)}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-sm font-medium">Private</div>
                  <div className="text-ink-muted text-xs">
                    Only you and organization members can see this collection.
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-2.5">
                <input
                  type="radio"
                  name="visibility"
                  checked={isPublic}
                  onChange={() => setIsPublic(true)}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-sm font-medium">Public</div>
                  <div className="text-ink-muted text-xs">
                    Anyone can see this collection. It will appear in Explore.
                  </div>
                </div>
              </label>
            </div>
          </fieldset>

          <hr className="border-rule" />

          <button
            type="submit"
            disabled={submitting || !slug || !owner}
            className="bg-ink text-parchment w-full rounded px-4 py-2.5 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Creating...' : 'Create collection'}
          </button>
        </form>
      </div>
    </BaseLayout>
  )
}
