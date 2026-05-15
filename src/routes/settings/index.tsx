import { type FormEvent, useState, } from 'react'
import { Link, } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData, } from '~/lib/ssr-data'

export default function Settings() {
  const me = useSSRData<any>('currentUser',)
  const kfAccountUrl = useSSRData<string>('kfAccountUrl',)

  const [success, setSuccess,] = useState('',)
  const [error, setError,] = useState('',)

  // Profile form (Underlay-specific fields only — name/email/avatar managed by KF Auth)
  const [slugValue, setSlugValue,] = useState(me?.slug ?? '',)
  const [bio, setBio,] = useState(me?.bio ?? '',)
  const [website, setWebsite,] = useState(me?.website ?? '',)
  const [location, setLocation,] = useState(me?.location ?? '',)

  // Notifications
  const notifPrefs = (me?.notificationPrefs as Record<string, boolean>) ?? {}
  const [collectionActivity, setCollectionActivity,] = useState(notifPrefs.collectionActivity ?? true,)
  const [orgInvitations, setOrgInvitations,] = useState(notifPrefs.orgInvitations ?? true,)
  const [securityAlerts, setSecurityAlerts,] = useState(notifPrefs.securityAlerts ?? true,)

  // Delete account
  const [confirmSlug, setConfirmSlug,] = useState('',)

  const [submitting, setSubmitting,] = useState('',)

  function clearMessages() {
    setSuccess('',)
    setError('',)
  }

  async function handleUpdateProfile(e: FormEvent,) {
    e.preventDefault()
    clearMessages()
    setSubmitting('profile',)
    const slugChanged = slugValue.trim() !== '' && slugValue.trim() !== me?.slug
    try {
      const payload: Record<string, any> = { bio, website, location, }
      if (slugChanged) payload.slug = slugValue.trim()

      const res = await fetch('/api/accounts/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', },
        credentials: 'include',
        body: JSON.stringify(payload,),
      },)
      if (res.ok) {
        if (slugChanged) {
          window.location.href = '/settings'
          return
        }
        setSuccess('Profile updated.',)
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Update failed.',)
      }
    } finally {
      setSubmitting('',)
    }
  }

  async function handleUpdateNotifications(e: FormEvent,) {
    e.preventDefault()
    clearMessages()
    setSubmitting('notifications',)
    try {
      const res = await fetch('/api/accounts/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', },
        credentials: 'include',
        body: JSON.stringify({ notificationPrefs: { collectionActivity, orgInvitations, securityAlerts, }, },),
      },)
      if (res.ok) {
        setSuccess('Notification preferences saved.',)
      } else {
        setError('Failed to save preferences.',)
      }
    } finally {
      setSubmitting('',)
    }
  }

  async function handleDeleteAccount(e: FormEvent,) {
    e.preventDefault()
    clearMessages()
    setSubmitting('delete',)
    try {
      const res = await fetch('/api/accounts/me', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', },
        credentials: 'include',
        body: JSON.stringify({ confirmSlug, },),
      },)
      if (res.ok) {
        window.location.href = '/'
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to delete account.',)
      }
    } finally {
      setSubmitting('',)
    }
  }

  if (!me) return null

  return (
    <BaseLayout>
      <div className='max-w-4xl mx-auto px-4 py-10'>
        <h1 className='text-xl font-semibold tracking-tight mb-6'>Settings</h1>

        <nav className='flex gap-4 text-sm border-b border-rule mb-6 pb-2'>
          <Link to='/settings' className='text-ink font-medium'>Account</Link>
          <Link to='/settings/keys' className='text-ink-muted hover:text-ink'>API Keys</Link>
          <Link to='/settings/sessions' className='text-ink-muted hover:text-ink'>Sessions</Link>
        </nav>

        {success && (
          <p className='text-sm text-green-800 bg-green-50 border border-green-200 px-3 py-2 mb-4'>{success}</p>
        )}
        {error && <p className='text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 mb-4'>{error}</p>}

        {/* Profile */}
        <form onSubmit={handleUpdateProfile} className='space-y-4 mb-10'>
          <h2 className='text-sm font-semibold uppercase tracking-wide text-ink-muted'>Profile</h2>

          <div className='flex items-center gap-4 mb-4'>
            {me.avatarUrl
              ? (
                <img
                  src={me.avatarUrl}
                  alt='Avatar'
                  className='w-16 h-16 rounded-full object-cover border border-rule'
                />
              )
              : (
                <div className='w-16 h-16 rounded-full bg-parchment-dark border border-rule flex items-center justify-center text-ink-muted text-lg font-semibold'>
                  {me.displayName?.charAt(0,)?.toUpperCase() ?? '?'}
                </div>
              )}
            <div>
              <p className='text-sm font-medium'>{me.displayName}</p>
              <p className='text-xs text-ink-muted font-mono'>@{me.slug}</p>
              <a
                href={kfAccountUrl}
                target='_blank'
                rel='noopener noreferrer'
                className='text-xs text-link hover:underline mt-1 inline-block'
              >
                Edit name or avatar at KF Account →
              </a>
            </div>
          </div>

          <div>
            <label className='block text-sm font-medium mb-1'>Display Name</label>
            <p className='text-sm text-ink-muted'>{me.displayName}</p>
            <p className='text-xs text-ink-muted mt-1'>
              Managed by your{' '}
              <a href={kfAccountUrl} target='_blank' rel='noopener noreferrer' className='text-link hover:underline'>
                KF Account
              </a>.
            </p>
          </div>
          <div>
            <label htmlFor='bio' className='block text-sm font-medium mb-1'>Bio</label>
            <textarea
              id='bio'
              rows={3}
              placeholder='A short bio...'
              value={bio}
              onChange={(e,) => setBio(e.target.value,)}
              className='w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink resize-none'
            />
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div>
              <label htmlFor='website' className='block text-sm font-medium mb-1'>Website</label>
              <input
                type='url'
                id='website'
                value={website}
                onChange={(e,) => setWebsite(e.target.value,)}
                placeholder='https://...'
                className='w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink'
              />
            </div>
            <div>
              <label htmlFor='location' className='block text-sm font-medium mb-1'>Location</label>
              <input
                type='text'
                id='location'
                value={location}
                onChange={(e,) => setLocation(e.target.value,)}
                placeholder='City, Country'
                className='w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink'
              />
            </div>
          </div>
          <div>
            <label htmlFor='slug' className='block text-sm font-medium mb-1'>Username</label>
            <input
              type='text'
              id='slug'
              value={slugValue}
              onChange={(e,) => setSlugValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '',),)}
              pattern='[a-z0-9][a-z0-9-]*[a-z0-9]'
              className='w-full bg-parchment border border-rule px-3 py-2 text-sm font-mono focus:outline-none focus:border-ink'
            />
            {slugValue !== me?.slug && (
              <p className='text-xs text-amber-700 mt-1'>Changing your username will update all your URLs.</p>
            )}
          </div>
          <button
            type='submit'
            disabled={submitting === 'profile'}
            className='bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity'
          >
            Save profile
          </button>
        </form>

        {/* KF Auth Account — name, email, avatar, password, security */}
        <div className='border-t border-rule pt-6 mb-10'>
          <h2 className='text-sm font-semibold uppercase tracking-wide text-ink-muted mb-4'>Account &amp; Security</h2>
          <p className='text-sm text-ink-muted mb-3'>
            Your name, email, avatar, password, and security settings are managed through your KF Account.
          </p>
          <a
            href={kfAccountUrl}
            target='_blank'
            rel='noopener noreferrer'
            className='inline-block bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity'
          >
            Manage account →
          </a>
        </div>

        {/* Notifications */}
        <div className='border-t border-rule pt-6 mb-10'>
          <h2 className='text-sm font-semibold uppercase tracking-wide text-ink-muted mb-4'>Notifications</h2>
          <p className='text-xs text-ink-muted mb-3'>Email notifications (requires SMTP configuration).</p>
          <form onSubmit={handleUpdateNotifications} className='space-y-3'>
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={collectionActivity}
                onChange={(e,) => setCollectionActivity(e.target.checked,)}
                className='accent-ink'
              />
              Collection activity (new versions pushed)
            </label>
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={orgInvitations}
                onChange={(e,) => setOrgInvitations(e.target.checked,)}
                className='accent-ink'
              />
              Organization invitations
            </label>
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={securityAlerts}
                onChange={(e,) => setSecurityAlerts(e.target.checked,)}
                className='accent-ink'
              />
              Security alerts (new logins, password changes)
            </label>
            <button
              type='submit'
              disabled={submitting === 'notifications'}
              className='bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity'
            >
              Save preferences
            </button>
          </form>
        </div>

        {/* Danger zone */}
        <div className='border border-red-200 p-4'>
          <h2 className='text-sm font-semibold text-red-700 mb-2'>Danger Zone</h2>
          <p className='text-sm text-ink-muted mb-3'>
            Permanently delete your account. You must first transfer or delete all your collections.
          </p>
          <details className='group'>
            <summary className='text-sm text-red-700 cursor-pointer hover:underline'>Delete my account…</summary>
            <form onSubmit={handleDeleteAccount} className='mt-3 space-y-3'>
              <div>
                <label htmlFor='confirmSlug' className='block text-sm text-ink-muted mb-1'>
                  Type <strong>{me.slug}</strong> to confirm:
                </label>
                <input
                  type='text'
                  id='confirmSlug'
                  value={confirmSlug}
                  onChange={(e,) => setConfirmSlug(e.target.value,)}
                  required
                  autoComplete='off'
                  className='w-full bg-parchment border border-red-200 px-3 py-2 text-sm focus:outline-none focus:border-red-400'
                />
              </div>
              <button
                type='submit'
                disabled={submitting === 'delete'}
                className='bg-red-700 text-white px-4 py-2 text-sm font-medium hover:bg-red-800 transition-colors'
              >
                Delete my account
              </button>
            </form>
          </details>
        </div>
      </div>
    </BaseLayout>
  )
}
