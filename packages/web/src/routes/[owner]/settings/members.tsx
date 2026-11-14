import { type FormEvent, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'

import SettingsLayout, { orgSettingsRail } from '~/components/SettingsLayout'
import { Alert, Badge, Button, Input } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'
import { authClient } from '~/lib/auth-client'
import { formatDate } from '~/lib/format'

export default function OwnerSettingsMembers() {
  const { owner } = useParams()
  const { currentUser } = useAppContext()

  const org = currentUser?.orgs?.find((o: any) => o.slug === owner)
  const orgId = org?.organizationId ?? null
  const isOwner = org?.role === 'owner'
  const isAdmin = org?.role === 'admin' || isOwner

  /** Null until the first load answers. */
  const [members, setMembers] = useState<any[] | null>(null)
  const [invitations, setInvitations] = useState<any[]>([])
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  /** Whether the org's public page lists the signed-in member; null until loaded. */
  const [listed, setListed] = useState<boolean | null>(null)

  const [addEmails, setAddEmails] = useState('')
  const [addRole, setAddRole] = useState('member')
  const [pendingAdds, setPendingAdds] = useState<{ id: string; email: string; role: string }[]>([])

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('member')
  const [copied, setCopied] = useState('')

  async function loadMembers(organizationId: string) {
    const { data } = await authClient.organization.listMembers({
      query: { organizationId },
    } as any)
    setMembers((data as any)?.members ?? [])
  }

  async function loadInvitations(organizationId: string) {
    const { data } = await authClient.organization.listInvitations({
      query: { organizationId },
    } as any)
    if (data) setInvitations(Array.isArray(data) ? data : [])
  }

  async function loadPendingAdds(slug: string) {
    const res = await fetch(`/api/accounts/${slug}/members/pending`, { credentials: 'include' })
    setPendingAdds(res.ok ? await res.json() : [])
  }

  /** Adds each address: members at once if they have an account here, else on first sign-in. */
  async function handleAddMembers(e: FormEvent) {
    e.preventDefault()
    if (!orgId || !owner) return
    clearMessages()
    const emails = addEmails
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean)
    if (!emails.length) return
    setSubmitting(true)
    const added: string[] = []
    const waiting: string[] = []
    const failed: string[] = []
    try {
      for (const email of emails) {
        const res = await fetch(`/api/accounts/${owner}/members`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, role: addRole }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) failed.push(`${email}: ${body.error ?? 'failed'}`)
        else if (body.status === 'pending') waiting.push(email)
        else added.push(body.name ?? email)
      }
    } finally {
      setSubmitting(false)
    }
    const parts = []
    if (added.length) parts.push(`Added ${added.join(', ')}.`)
    if (waiting.length)
      parts.push(`${waiting.join(', ')} will join the first time they sign in to Underlay.`)
    if (parts.length) setSuccess(parts.join(' '))
    if (failed.length) setError(failed.join('; '))
    setAddEmails(failed.map((f) => f.split(':')[0]).join(', '))
    await Promise.all([loadMembers(orgId), loadPendingAdds(owner)])
  }

  async function handleRemovePendingAdd(id: string) {
    if (!owner) return
    clearMessages()
    const res = await fetch(`/api/accounts/${owner}/members/pending/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    if (!res.ok) setError('Failed to remove.')
    await loadPendingAdds(owner)
  }

  async function loadListed(slug: string) {
    const res = await fetch(`/api/accounts/${slug}/members`, { credentials: 'include' })
    const rows = res.ok ? ((await res.json()) as { you?: boolean; public?: boolean }[]) : []
    setListed(rows.find((r) => r.you)?.public ?? false)
  }

  useEffect(() => {
    if (!orgId) return
    loadMembers(orgId)
    loadInvitations(orgId)
    if (owner) loadListed(owner)
    if (owner && isAdmin) loadPendingAdds(owner)
  }, [orgId, owner])

  if (currentUser && !org) {
    window.location.href = `/${owner}`
    return null
  }

  function clearMessages() {
    setSuccess('')
    setError('')
  }

  async function handleChangeRole(memberId: string, role: string) {
    if (!orgId) return
    clearMessages()
    const { error: err } = await authClient.organization.updateMemberRole({
      memberId,
      role,
      organizationId: orgId,
    } as any)
    if (err) {
      setError(err.message ?? 'Failed to update role.')
    } else {
      setSuccess('Role updated.')
      await loadMembers(orgId)
    }
  }

  async function handleRemoveMember(memberIdOrEmail: string) {
    if (!orgId) return
    clearMessages()
    const { error: err } = await authClient.organization.removeMember({
      memberIdOrEmail,
      organizationId: orgId,
    } as any)
    if (err) {
      setError(err.message ?? 'Failed to remove member.')
    } else {
      setSuccess('Member removed.')
      await loadMembers(orgId)
    }
  }

  async function handleSetListed(value: boolean) {
    clearMessages()
    const res = await fetch(`/api/accounts/${owner}/members/me`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ public: value }),
    })
    if (!res.ok) {
      setError('Failed to change how your membership is shown.')
      return
    }
    setListed(value)
    setSuccess(
      value
        ? 'Your name is now listed on the organization page.'
        : 'Your membership is now hidden.',
    )
  }

  async function handleLeaveOrg() {
    if (!orgId) return
    clearMessages()
    const { error: err } = await authClient.organization.leave({
      organizationId: orgId,
    } as any)
    if (err) {
      setError(err.message ?? 'Failed to leave organization.')
    } else {
      window.location.href = '/dashboard'
    }
  }

  async function handleInviteMember(e: FormEvent) {
    e.preventDefault()
    if (!orgId) return
    clearMessages()
    setSubmitting(true)
    try {
      const { error: err } = await authClient.organization.inviteMember({
        email: inviteEmail,
        role: inviteRole,
        organizationId: orgId,
      } as any)
      if (err) {
        setError(err.message ?? 'Failed to send invitation.')
      } else {
        // Nothing emails invitations yet: the inviter shares the link below.
        setSuccess(
          `Invitation created for ${inviteEmail}. Copy its link below and send it to them.`,
        )
        setInviteEmail('')
        await loadInvitations(orgId)
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function copyInviteLink(invitationId: string) {
    const link = `${window.location.origin}/invitations/accept?invitation=${encodeURIComponent(invitationId)}`
    await navigator.clipboard.writeText(link)
    setCopied(invitationId)
  }

  async function handleCancelInvitation(invitationId: string) {
    clearMessages()
    const { error: err } = await authClient.organization.cancelInvitation({
      invitationId,
    } as any)
    if (err) {
      setError(err.message ?? 'Failed to cancel invitation.')
    } else {
      setSuccess('Invitation cancelled.')
      if (orgId) await loadInvitations(orgId)
    }
  }

  const pendingInvitations = invitations.filter((i: any) => i.status === 'pending')

  return (
    <SettingsLayout
      crumb={
        <nav>
          <Link to={`/${owner}`} className="text-link hover:underline">
            {owner}
          </Link>{' '}
          <span className="text-ink-muted">/</span> <span className="text-ink-muted">settings</span>
        </nav>
      }
      title="Members"
      description="Who can push to and administer this organization's collections."
      groups={orgSettingsRail(owner!)}
    >
      {success && (
        <Alert variant="success" className="mb-4">
          {success}
        </Alert>
      )}
      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="mb-6 space-y-2" aria-busy={members === null}>
        {members === null &&
          [0, 1].map((i) => (
            <div
              key={i}
              className="border-rule rounded-surface bg-parchment-dark/40 h-[58px] animate-pulse border"
            />
          ))}
        {members?.map((m: any) => (
          <div
            key={m.id}
            className="border-rule rounded-surface flex items-center justify-between border p-3"
          >
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">{m.user?.name ?? m.userId}</span>
              <span className="text-ink-muted text-xs">{m.user?.email}</span>
              {isOwner && m.userId !== currentUser.id ? (
                <select
                  value={m.role}
                  onChange={(e) => handleChangeRole(m.id, e.target.value)}
                  className="bg-parchment border-rule rounded-control cursor-pointer border px-1.5 py-0.5 text-xs"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  <option value="owner">Owner</option>
                </select>
              ) : (
                <Badge>{m.role}</Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && m.userId !== currentUser.id && (
                <Button variant="dangerLink" size="sm" onClick={() => handleRemoveMember(m.id)}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="border-rule mb-6 border-t pt-6">
        <h3 className="text-ink-muted mb-2 text-xs font-semibold">Your membership</h3>
        <p className="text-ink-muted mb-3 text-sm">
          Members are hidden from people outside the organization unless they choose to be listed. A
          listed member's name appears on the organization page; roles are never shown there.
        </p>
        {listed !== null && (
          <div className="flex items-center gap-3">
            <span className="text-sm">{listed ? 'Listed publicly' : 'Hidden'}</span>
            <Button variant="link" size="sm" onClick={() => handleSetListed(!listed)}>
              {listed ? 'Hide my membership' : 'List my name publicly'}
            </Button>
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="border-rule mb-6 space-y-3 border-t pt-6">
          <h3 className="text-ink-muted text-xs font-semibold">Add members</h3>
          <p className="text-ink-muted text-sm">
            Anyone with an Underlay account joins at once. Anyone else joins the first time they
            sign in with that address. They can leave at any time.
          </p>
          <form onSubmit={handleAddMembers} className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-[1_1_16rem]">
              <label htmlFor="addEmails" className="mb-1 block text-xs font-medium">
                Email addresses
              </label>
              <Input
                id="addEmails"
                value={addEmails}
                onChange={(e) => setAddEmails(e.target.value)}
                required
                placeholder="ada@example.org, alan@example.org"
              />
            </div>
            <div>
              <label htmlFor="addRole" className="mb-1 block text-xs font-medium">
                Role
              </label>
              <select
                id="addRole"
                value={addRole}
                onChange={(e) => setAddRole(e.target.value)}
                className="bg-parchment border-rule focus:border-ink rounded-control cursor-pointer border px-3 py-2 text-sm focus:outline-none"
              >
                <option value="member">Member</option>
                {isOwner && <option value="admin">Admin</option>}
              </select>
            </div>
            <Button type="submit" disabled={submitting} className="whitespace-nowrap">
              {submitting ? 'Adding…' : 'Add'}
            </Button>
          </form>
          {pendingAdds.length > 0 && (
            <div className="space-y-2 pt-2">
              <p className="text-ink-muted text-xs">Joining when they first sign in</p>
              {pendingAdds.map((p) => (
                <div
                  key={p.id}
                  className="border-rule rounded-surface flex items-center justify-between border border-dashed p-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm">{p.email}</span>
                    <Badge>{p.role}</Badge>
                  </div>
                  <Button
                    variant="dangerLink"
                    size="sm"
                    onClick={() => handleRemovePendingAdd(p.id)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="border-rule space-y-4 border-t pt-6">
          <h3 className="text-ink-muted text-xs font-semibold">Invite with a link</h3>
          <p className="text-ink-muted text-sm">
            For an owner, or anyone who should accept first. Underlay doesn't email invitations yet:
            copy the link and send it yourself.
          </p>
          <form onSubmit={handleInviteMember} className="flex items-end gap-3">
            <div className="flex-1">
              <label htmlFor="inviteEmail" className="mb-1 block text-xs font-medium">
                Email
              </label>
              <Input
                type="email"
                id="inviteEmail"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label htmlFor="inviteRole" className="mb-1 block text-xs font-medium">
                Role
              </label>
              <select
                id="inviteRole"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                className="bg-parchment border-rule focus:border-ink rounded-control cursor-pointer border px-3 py-2 text-sm focus:outline-none"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                {isOwner && <option value="owner">Owner</option>}
              </select>
            </div>
            <Button type="submit" disabled={submitting} className="whitespace-nowrap">
              {submitting ? 'Sending…' : 'Invite'}
            </Button>
          </form>
        </div>
      )}

      {pendingInvitations.length > 0 && (
        <div className="border-rule mt-6 border-t pt-6">
          <h3 className="text-ink-muted mb-2 text-xs font-semibold">Pending Invitations</h3>
          <div className="space-y-2">
            {pendingInvitations.map((inv: any) => (
              <div
                key={inv.id}
                className="border-rule rounded-surface flex items-center justify-between border border-dashed p-3"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm">{inv.email}</span>
                  <Badge>{inv.role}</Badge>
                  {inv.expiresAt && (
                    <span className="text-ink-muted text-xs">
                      Expires {formatDate(inv.expiresAt)}
                    </span>
                  )}
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-3">
                    <Button variant="link" size="sm" onClick={() => copyInviteLink(inv.id)}>
                      {copied === inv.id ? 'Copied' : 'Copy link'}
                    </Button>
                    <Button
                      variant="dangerLink"
                      size="sm"
                      onClick={() => handleCancelInvitation(inv.id)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!isOwner && (
        <div className="border-rule mt-6 border-t pt-4">
          <details className="group">
            <summary className="cursor-pointer text-sm text-red-700 hover:underline">
              Leave this organization…
            </summary>
            <div className="mt-3 space-y-3">
              <p className="text-ink-muted text-sm">
                You will lose access to this organization's private collections and settings. An
                admin will need to re-invite you to rejoin.
              </p>
              <Button variant="danger" onClick={handleLeaveOrg}>
                Leave organization
              </Button>
            </div>
          </details>
        </div>
      )}
    </SettingsLayout>
  )
}
