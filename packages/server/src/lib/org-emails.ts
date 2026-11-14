/**
 * The emails KF Auth sends for an org (auth/kf.ts invite): an invitation to accept, and a
 * note to someone added by email who has no account here yet. KF supplies the link
 * (`{{invitation_url}}`), the sender ("Underlay via Knowledge Futures") and a footer.
 */
import type { KfInvite } from '../auth/kf.js'

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `/login`, returning to `path` once they're signed in. */
export const signInThen = (appUrl: string, path: string) =>
  `${new URL(appUrl).origin}/login?return_to=${encodeURIComponent(path)}`

const roleNoun = (role: string) =>
  role === 'admin' ? 'an admin' : role === 'owner' ? 'an owner' : 'a member'

export function invitationEmail(opts: {
  appUrl: string
  email: string
  invitationId: string
  orgName: string
  inviterName: string | null
  role: string
}): KfInvite {
  const who = opts.inviterName ? escape(opts.inviterName) : 'Someone'
  return {
    email: opts.email,
    return_to: signInThen(
      opts.appUrl,
      `/invitations/accept?invitation=${encodeURIComponent(opts.invitationId)}`,
    ),
    subject: `Join ${opts.orgName} on Underlay`,
    html:
      `<p>${who} invited you to join <strong>${escape(opts.orgName)}</strong> on Underlay as ${roleNoun(opts.role)}.</p>` +
      `<p><a href="{{invitation_url}}">Accept the invitation</a></p>`,
  }
}

export function addedEmail(opts: {
  appUrl: string
  email: string
  orgSlug: string
  orgName: string
  adderName: string | null
  role: string
}): KfInvite {
  const who = opts.adderName ? escape(opts.adderName) : 'Someone'
  return {
    email: opts.email,
    return_to: signInThen(opts.appUrl, `/${opts.orgSlug}`),
    subject: `You've been added to ${opts.orgName} on Underlay`,
    html:
      `<p>${who} added you to <strong>${escape(opts.orgName)}</strong> on Underlay as ${roleNoun(opts.role)}. ` +
      `Sign in to start using it.</p>` +
      `<p><a href="{{invitation_url}}">Sign in to Underlay</a></p>`,
  }
}
