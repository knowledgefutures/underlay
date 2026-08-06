import { type FormEvent, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'

import SettingsLayout, { orgSettingsRail } from '~/components/SettingsLayout'
import { Alert, Badge, Button, Input } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'
import { authClient } from '~/lib/auth-client'

export default function OwnerSettingsMembers() {
  const { owner } = useParams()
  const { currentUser } = useAppContext()

  const org = currentUser?.orgs?.find((o: any) => o.slug === owner)
  const orgId = org?.organizationId ?? null
  const isOwner = org?.role === 'owner'
  const isAdmin = org?.role === 'admin' || isOwner

  const [members, setMembers] = useState<any[]>([])
  const [invitations, setInvitations] = useState<any[]>([])
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('member')

  async function loadMembers(organizationId: string) {
    const { data } = await authClient.organization.listMembers({
      query: { organizationId },
    } as any)
    if (data) setMembers((data as any).members ?? [])
  }

  async function loadInvitations(organizationId: string) {
    const { data } = await authClient.organization.listInvitations({
      query: { organizationId },
    } as any)
    if (data) setInvitations(Array.isArray(data) ? data : [])
  }

  useEffect(() => {
    if (!orgId) return
    loadMembers(orgId)
    loadInvitations(orgId)
  }, [orgId])

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
        setSuccess(`Invitation sent to ${inviteEmail}.`)
        setInviteEmail('')
        await loadInvitations(orgId)
      }
    } finally {
      setSubmitting(false)
    }
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

      <div className="mb-6 space-y-2">
        {members.map((m: any) => (
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

      {isAdmin && (
        <div className="border-rule space-y-4 border-t pt-6">
          <h3 className="text-ink-muted text-xs font-semibold">Invite by email</h3>
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
                      Expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {isAdmin && (
                  <Button
                    variant="dangerLink"
                    size="sm"
                    onClick={() => handleCancelInvitation(inv.id)}
                  >
                    Cancel
                  </Button>
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
