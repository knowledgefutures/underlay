import { type FormEvent, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { Alert, Button, Field, Input, Select } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'

export default function NewCollection() {
  const { currentUser } = useAppContext()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const ownerOptions = (currentUser?.orgs ?? []).map((o: any) => ({
    slug: o.slug,
    label: `${o.name ?? o.displayName ?? o.slug}${o.isDefault ? ' (personal)' : ''}`,
  }))
  // Prefer the org the user navigated from (?owner=), then their personal org.
  const requestedOwner = searchParams.get('owner')
  const defaultOwner =
    (requestedOwner && currentUser?.orgs?.find((o: any) => o.slug === requestedOwner)) ||
    currentUser?.orgs?.find((o: any) => o.isDefault) ||
    currentUser?.orgs?.[0]

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
          {error && <Alert variant="error">{error}</Alert>}

          <Field label="Owner">
            {ownerOptions.length > 1 ? (
              <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
                {ownerOptions.map((o: any) => (
                  <option key={o.slug} value={o.slug}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="bg-parchment-dark border-rule rounded-control border px-3 py-2 text-sm">
                {ownerOptions[0]?.label ?? owner}
              </div>
            )}
          </Field>

          <Field
            label="Collection name"
            hint={
              <>
                Lowercase letters, numbers, and hyphens. This becomes the URL:{' '}
                <span className="font-mono">
                  {owner}/{slug || '...'}
                </span>
              </>
            }
          >
            <Input
              type="text"
              required
              pattern="[a-z0-9][-a-z0-9]*[a-z0-9]"
              minLength={2}
              placeholder="my-dataset"
              value={slug}
              onChange={(e) => setSlug(slugify(e.target.value))}
            />
          </Field>

          <Field
            label={
              <>
                Description <span className="text-ink-muted font-normal">(optional)</span>
              </>
            }
          >
            <Input
              type="text"
              placeholder="A short description of this collection"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

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
                  className="accent-ink mt-0.5"
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
                  className="accent-ink mt-0.5"
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

          <Button type="submit" disabled={submitting || !slug || !owner} className="w-full">
            {submitting ? 'Creating...' : 'Create collection'}
          </Button>
        </form>
      </div>
    </BaseLayout>
  )
}
