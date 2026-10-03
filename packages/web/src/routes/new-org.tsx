import { type FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { Alert, Button, Field, Input, Select } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'
import { authClient } from '~/lib/auth-client'

interface KfAccount {
  id: string
  name: string
  slug: string
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
}

export default function NewOrg() {
  const { currentUser } = useAppContext()
  const navigate = useNavigate()

  const [kfAccounts, setKfAccounts] = useState<KfAccount[]>([])
  const [kfOrgId, setKfOrgId] = useState('')
  const [slug, setSlug] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/accounts/available-kf-orgs', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((accounts: KfAccount[]) => {
        setKfAccounts(accounts)
        if (accounts.length === 1 && accounts[0]) setKfOrgId(accounts[0].id)
        setLoaded(true)
      })
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const { data, error: err } = await authClient.organization.create({
        name: displayName,
        slug,
        kfOrgId: kfOrgId || undefined,
      } as any)
      if (err) {
        setError(err.message ?? 'Failed to create organization')
      } else if (data) {
        navigate(`/${slug}`)
      }
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    if (!currentUser) navigate('/login')
  }, [currentUser, navigate])

  if (!currentUser) return null

  return (
    <BaseLayout>
      <div className="mx-auto max-w-lg px-4 py-10">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Create a new organization</h1>
        <p className="text-ink-muted mb-8 text-sm">
          Organizations let you publish collections and manage members under a shared account.
        </p>

        {!loaded ? (
          <p className="text-ink-muted text-sm">Loading...</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && <Alert variant="error">{error}</Alert>}

            <Field label="Display name">
              <Input
                type="text"
                required
                placeholder="My Organization"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>

            <Field
              label="URL slug"
              hint={
                <>
                  Lowercase letters, numbers, and hyphens. This becomes the URL:{' '}
                  <span className="font-mono">underlay.org/{slug || '...'}</span>
                </>
              }
            >
              <Input
                type="text"
                required
                pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]"
                minLength={2}
                placeholder="my-org"
                value={slug}
                onChange={(e) => setSlug(slugify(e.target.value))}
              />
            </Field>

            {/* KF Account — only shown when user has multiple */}
            {kfAccounts.length > 1 && (
              <Field
                label="KF Account"
                hint="Choose which Knowledge Futures account this organization belongs to."
              >
                <Select
                  required
                  value={kfOrgId}
                  onChange={(e) => {
                    setKfOrgId(e.target.value)
                    const acct = kfAccounts.find((a) => a.id === e.target.value)
                    if (acct) {
                      if (!displayName) setDisplayName(acct.name)
                      if (!slug) setSlug(slugify(acct.name))
                    }
                  }}
                >
                  <option value="">Select a KF account...</option>
                  {kfAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <hr className="border-rule" />

            <Button
              type="submit"
              disabled={submitting || !slug || !displayName || (kfAccounts.length > 1 && !kfOrgId)}
              className="w-full"
            >
              {submitting ? 'Creating...' : 'Create organization'}
            </Button>
          </form>
        )}
      </div>
    </BaseLayout>
  )
}
