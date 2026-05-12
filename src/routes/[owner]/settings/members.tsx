import { type FormEvent, useEffect, useState, } from 'react'
import { Link, useParams, } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { NotFoundError, } from '~/components/NotFound'
import { useSSRData, } from '~/lib/ssr-data'

export default function OwnerSettingsMembers() {
  const { owner, } = useParams()
  const currentUser = useSSRData<any>('currentUser',)

  const [orgData, setOrgData,] = useState<any>(null,)
  const [isOwner, setIsOwner,] = useState(false,)
  const [isAdmin, setIsAdmin,] = useState(false,)
  const [members, setMembers,] = useState<any[]>([],)
  const [invitations, setInvitations,] = useState<any[]>([],)
  const [loading, setLoading,] = useState(true,)
  const [success, setSuccess,] = useState('',)
  const [error, setError,] = useState('',)
  const [submitting, setSubmitting,] = useState(false,)

  // Add member form
  const [addUsername, setAddUsername,] = useState('',)
  const [addRole, setAddRole,] = useState('member',)

  // Invite form
  const [inviteEmail, setInviteEmail,] = useState('',)
  const [inviteRole, setInviteRole,] = useState('member',)

  useEffect(() => {
    if (!owner || !currentUser) return

    const org = currentUser.orgs?.find((o: any,) => o.slug === owner)
    if (!org) {
      window.location.href = `/${owner}`
      return
    }

    const ownerRole = org.role === 'owner'
    const adminRole = org.role === 'admin' || ownerRole
    setIsOwner(ownerRole,)
    setIsAdmin(adminRole,)

    Promise.all([
      fetch(`/api/accounts/${owner}`, { credentials: 'include', },).then((r,) => r.ok ? r.json() : null),
      fetch(`/api/accounts/${owner}/members`, { credentials: 'include', },).then((r,) => r.ok ? r.json() : []),
      fetch(`/api/accounts/${owner}/invitations`, { credentials: 'include', },).then((r,) => r.ok ? r.json() : []),
    ],).then(([org, m, inv,],) => {
      if (!org) {
        setLoading(false,)
        return
      }
      setOrgData(org,)
      setMembers(m,)
      setInvitations(inv,)
      setLoading(false,)
    },)
  }, [owner, currentUser,],)

  if (!currentUser) {
    window.location.href = '/login'
    return null
  }

  function clearMessages() {
    setSuccess('',)
    setError('',)
  }

  async function refreshMembers() {
    const res = await fetch(`/api/accounts/${owner}/members`, { credentials: 'include', },)
    if (res.ok) setMembers(await res.json(),)
  }

  async function refreshInvitations() {
    const res = await fetch(`/api/accounts/${owner}/invitations`, { credentials: 'include', },)
    if (res.ok) setInvitations(await res.json(),)
  }

  async function handleAddMember(e: FormEvent,) {
    e.preventDefault()
    clearMessages()
    setSubmitting(true,)
    try {
      const res = await fetch(`/api/accounts/${owner}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', },
        credentials: 'include',
        body: JSON.stringify({ username: addUsername, role: addRole, },),
      },)
      if (res.ok) {
        setSuccess(`Added ${addUsername} as ${addRole}.`,)
        setAddUsername('',)
        await refreshMembers()
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to add member.',)
      }
    } finally {
      setSubmitting(false,)
    }
  }

  async function handleChangeRole(userId: string, role: string,) {
    clearMessages()
    const res = await fetch(`/api/accounts/${owner}/members/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', },
      credentials: 'include',
      body: JSON.stringify({ role, },),
    },)
    if (res.ok) {
      setSuccess('Role updated.',)
      await refreshMembers()
    } else {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Failed to update role.',)
    }
  }

  async function handleRemoveMember(userId: string,) {
    clearMessages()
    const res = await fetch(`/api/accounts/${owner}/members/${userId}`, {
      method: 'DELETE',
      credentials: 'include',
    },)
    if (res.ok) {
      setSuccess('Member removed.',)
      await refreshMembers()
    } else {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Failed to remove member.',)
    }
  }

  async function handleLeaveOrg() {
    clearMessages()
    const res = await fetch(`/api/accounts/${owner}/members/${currentUser.id}`, {
      method: 'DELETE',
      credentials: 'include',
    },)
    if (res.ok) {
      window.location.href = '/dashboard'
    } else {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Failed to leave organization.',)
    }
  }

  async function handleInviteMember(e: FormEvent,) {
    e.preventDefault()
    clearMessages()
    setSubmitting(true,)
    try {
      const res = await fetch(`/api/accounts/${owner}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', },
        credentials: 'include',
        body: JSON.stringify({ email: inviteEmail, role: inviteRole, },),
      },)
      if (res.ok) {
        setSuccess(`Invitation sent to ${inviteEmail}.`,)
        setInviteEmail('',)
        await refreshInvitations()
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to send invitation.',)
      }
    } finally {
      setSubmitting(false,)
    }
  }

  async function handleCancelInvitation(invitationId: string,) {
    clearMessages()
    const res = await fetch(`/api/accounts/${owner}/invitations/${invitationId}`, {
      method: 'DELETE',
      credentials: 'include',
    },)
    if (res.ok) {
      setSuccess('Invitation cancelled.',)
      await refreshInvitations()
    } else {
      setError('Failed to cancel invitation.',)
    }
  }

  if (loading) {
    return (
      <BaseLayout>
        <div className='max-w-4xl mx-auto px-4 py-10 text-sm text-ink-muted'>Loading…</div>
      </BaseLayout>
    )
  }
  if (!orgData) throw new NotFoundError()

  const pendingInvitations = invitations.filter((i: any,) => !i.acceptedAt)

  return (
    <BaseLayout>
      <div className='max-w-4xl mx-auto px-4 py-10'>
        <nav className='text-xs text-ink-muted mb-6'>
          <Link to={`/${owner}`} className='hover:text-ink'>
            {owner}
          </Link>
          <span className='mx-1'>/</span>
          <span className='text-ink font-medium'>settings</span>
        </nav>

        <h1 className='text-xl font-semibold tracking-tight mb-6'>Organization Settings</h1>

        <nav className='flex gap-4 text-sm border-b border-rule mb-6 pb-2'>
          <Link to={`/${owner}/settings`} className='text-ink-muted hover:text-ink'>
            Profile
          </Link>
          <Link to={`/${owner}/settings/members`} className='text-ink font-medium'>
            Members
          </Link>
          <Link to={`/${owner}/settings/keys`} className='text-ink-muted hover:text-ink'>
            API Keys
          </Link>
        </nav>

        {success && (
          <p className='text-sm text-green-800 bg-green-50 border border-green-200 px-3 py-2 mb-4'>
            {success}
          </p>
        )}
        {error && (
          <p className='text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 mb-4'>
            {error}
          </p>
        )}

        <h2 className='text-sm font-semibold uppercase tracking-wide text-ink-muted mb-4'>
          Members ({members.length})
        </h2>

        <div className='space-y-2 mb-6'>
          {members.map((m: any,) => (
            <div
              key={m.userId}
              className='flex items-center justify-between border border-rule p-3'
            >
              <div className='flex items-center gap-3'>
                <Link
                  to={`/${m.slug}`}
                  className='font-semibold text-sm text-link underline'
                >
                  {m.slug}
                </Link>
                <span className='text-xs text-ink-muted'>{m.displayName}</span>
                {isOwner && m.userId !== currentUser.id
                  ? (
                    <select
                      value={m.role}
                      onChange={(e,) => handleChangeRole(m.userId, e.target.value,)}
                      className='text-xs bg-parchment border border-rule px-1.5 py-0.5 cursor-pointer'
                    >
                      <option value='member'>Member</option>
                      <option value='admin'>Admin</option>
                      <option value='owner'>Owner</option>
                    </select>
                  )
                  : <span className='text-xs border border-rule px-1.5 py-0.5'>{m.role}</span>}
              </div>
              <div className='flex items-center gap-2'>
                {isAdmin && m.userId !== currentUser.id && (
                  <button
                    onClick={() => handleRemoveMember(m.userId,)}
                    className='text-xs text-red-700 hover:underline'
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {isAdmin && (
          <div className='space-y-4 border-t border-rule pt-6'>
            <h3 className='text-xs font-semibold text-ink-muted'>Add by username</h3>
            <form onSubmit={handleAddMember} className='flex items-end gap-3'>
              <div className='flex-1'>
                <label htmlFor='username' className='block text-xs font-medium mb-1'>
                  Username
                </label>
                <input
                  type='text'
                  id='username'
                  value={addUsername}
                  onChange={(e,) => setAddUsername(e.target.value,)}
                  required
                  placeholder='e.g. jsmith'
                  className='w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink'
                />
              </div>
              <div>
                <label htmlFor='addRole' className='block text-xs font-medium mb-1'>
                  Role
                </label>
                <select
                  id='addRole'
                  value={addRole}
                  onChange={(e,) => setAddRole(e.target.value,)}
                  className='bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink'
                >
                  <option value='member'>Member</option>
                  <option value='admin'>Admin</option>
                  {isOwner && <option value='owner'>Owner</option>}
                </select>
              </div>
              <button
                type='submit'
                disabled={submitting}
                className='bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity whitespace-nowrap'
              >
                Add
              </button>
            </form>

            <h3 className='text-xs font-semibold text-ink-muted mt-4'>Invite by email</h3>
            <form onSubmit={handleInviteMember} className='flex items-end gap-3'>
              <div className='flex-1'>
                <label htmlFor='inviteEmail' className='block text-xs font-medium mb-1'>
                  Email
                </label>
                <input
                  type='email'
                  id='inviteEmail'
                  value={inviteEmail}
                  onChange={(e,) => setInviteEmail(e.target.value,)}
                  required
                  placeholder='user@example.com'
                  className='w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink'
                />
              </div>
              <div>
                <label htmlFor='inviteRole' className='block text-xs font-medium mb-1'>
                  Role
                </label>
                <select
                  id='inviteRole'
                  value={inviteRole}
                  onChange={(e,) => setInviteRole(e.target.value,)}
                  className='bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink'
                >
                  <option value='member'>Member</option>
                  <option value='admin'>Admin</option>
                  {isOwner && <option value='owner'>Owner</option>}
                </select>
              </div>
              <button
                type='submit'
                disabled={submitting}
                className='bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity whitespace-nowrap'
              >
                Invite
              </button>
            </form>
          </div>
        )}

        {/* Pending invitations */}
        {pendingInvitations.length > 0 && (
          <div className='mt-6 border-t border-rule pt-6'>
            <h3 className='text-xs font-semibold text-ink-muted mb-2'>Pending Invitations</h3>
            <div className='space-y-2'>
              {pendingInvitations.map((inv: any,) => (
                <div
                  key={inv.id}
                  className='flex items-center justify-between border border-rule border-dashed p-3'
                >
                  <div className='flex items-center gap-3'>
                    <span className='text-sm font-mono'>{inv.email}</span>
                    <span className='text-xs border border-rule px-1.5 py-0.5'>{inv.role}</span>
                    <span className='text-xs text-ink-muted'>
                      Expires {new Date(inv.expiresAt,).toLocaleDateString()}
                    </span>
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => handleCancelInvitation(inv.id,)}
                      className='text-xs text-red-700 hover:underline'
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Leave org */}
        {!isOwner && (
          <div className='mt-6 pt-4 border-t border-rule'>
            <button
              onClick={handleLeaveOrg}
              className='text-sm text-red-700 hover:underline'
            >
              Leave this organization
            </button>
          </div>
        )}
      </div>
    </BaseLayout>
  )
}
