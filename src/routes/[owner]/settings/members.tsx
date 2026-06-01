import { type FormEvent, useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { NotFoundError } from '~/components/NotFound'
import { useAppContext } from '~/lib/app-context'
import { authClient } from '~/lib/auth-client'

export const handle = {
  title: (params: Record<string, string>) => 'Members — ' + params.owner + ' — Underlay',
  requireAuth: true,
}

export default function OwnerSettingsMembers() {
  const { owner } = useParams()
  const { currentUser } = useAppContext()

  const [orgData, setOrgData] = useState<any>(null)
  const [orgId, setOrgId] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [members, setMembers] = useState<any[]>([])
  const [invitations, setInvitations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
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
    if (!owner || !currentUser) return

    const org = currentUser.orgs?.find((o: any) => o.slug === owner)
    if (!org) {
      window.location.href = `/${owner}`
      return
    }

    const id = org.organizationId
    setOrgId(id)
    setIsOwner(org.role === 'owner')
    setIsAdmin(org.role === 'admin' || org.role === 'owner')

    Promise.all([
      fetch(`/api/accounts/${owner}`, { credentials: 'include' }).then((r) =>
        r.ok ? r.json() : null,
      ),
      loadMembers(id),
      loadInvitations(id),
    ]).then(([orgResult]) => {
      if (orgResult) setOrgData(orgResult)
      setLoading(false)
    })
  }, [owner, currentUser])

  if (!currentUser) return <Navigate to="/login" replace />

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

  if (loading) {
    return (
      <BaseLayout>
        <div className="text-ink-muted mx-auto max-w-4xl px-4 py-10 text-sm">Loading…</div>
      </BaseLayout>
    )
  }
  if (!orgData) throw new NotFoundError()

  const pendingInvitations = invitations.filter((i: any) => i.status === 'pending')

  return (
    <BaseLayout>
      <div className="mx-auto max-w-4xl px-4 py-10">
        <nav className="text-ink-muted mb-6 text-xs">
          <Link to={`/${owner}`} className="hover:text-ink">
            {owner}
          </Link>
          <span className="mx-1">/</span>
          <span className="text-ink font-medium">settings</span>
        </nav>

        <h1 className="mb-6 text-xl font-semibold tracking-tight">Organization Settings</h1>

        <nav className="border-rule mb-6 flex gap-4 border-b pb-2 text-sm">
          <Link to={`/${owner}/settings`} className="text-ink-muted hover:text-ink">
            Profile
          </Link>
          <Link to={`/${owner}/settings/members`} className="text-ink font-medium">
            Members
          </Link>
          <Link to={`/${owner}/settings/keys`} className="text-ink-muted hover:text-ink">
            API Keys
          </Link>
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

        <h2 className="text-ink-muted mb-4 text-sm font-semibold tracking-wide uppercase">
          Members ({members.length})
        </h2>

        <div className="mb-6 space-y-2">
          {members.map((m: any) => (
            <div key={m.id} className="border-rule flex items-center justify-between border p-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{m.user?.name ?? m.userId}</span>
                <span className="text-ink-muted text-xs">{m.user?.email}</span>
                {isOwner && m.userId !== currentUser.id ? (
                  <select
                    value={m.role}
                    onChange={(e) => handleChangeRole(m.id, e.target.value)}
                    className="bg-parchment border-rule cursor-pointer border px-1.5 py-0.5 text-xs"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner</option>
                  </select>
                ) : (
                  <span className="border-rule border px-1.5 py-0.5 text-xs">{m.role}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isAdmin && m.userId !== currentUser.id && (
                  <button
                    onClick={() => handleRemoveMember(m.id)}
                    className="text-xs text-red-700 hover:underline"
                  >
                    Remove
                  </button>
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
                <input
                  type="email"
                  id="inviteEmail"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                  placeholder="user@example.com"
                  className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 text-sm focus:outline-none"
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
                  className="bg-parchment border-rule focus:border-ink border px-3 py-2 text-sm focus:outline-none"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  {isOwner && <option value="owner">Owner</option>}
                </select>
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="bg-ink text-parchment px-4 py-2 text-sm font-medium whitespace-nowrap transition-opacity hover:opacity-90"
              >
                Invite
              </button>
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
                  className="border-rule flex items-center justify-between border border-dashed p-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm">{inv.email}</span>
                    <span className="border-rule border px-1.5 py-0.5 text-xs">{inv.role}</span>
                    {inv.expiresAt && (
                      <span className="text-ink-muted text-xs">
                        Expires {new Date(inv.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => handleCancelInvitation(inv.id)}
                      className="text-xs text-red-700 hover:underline"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {!isOwner && (
          <div className="border-rule mt-6 border-t pt-4">
            <button onClick={handleLeaveOrg} className="text-sm text-red-700 hover:underline">
              Leave this organization
            </button>
          </div>
        )}
      </div>
    </BaseLayout>
  )
}
