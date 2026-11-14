import { useMemo } from 'react'
import { useLoaderData, useParams, useSearchParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import {
  AboutSection,
  ActivityList,
  CollectionsBrowser,
  MembersSection,
  NoCollections,
  type OrgAccount,
  type OrgActivity,
  type OrgCollection,
  OrgHeader,
  orgSummary,
  type OrgMember,
  type OrgTab,
  PinnedCards,
  UseThisData,
} from '~/components/org-page'
import { useAppContext } from '~/lib/app-context'
import { useIsOwner } from '~/lib/use-is-owner'

/** Search, sort and topics show from this many collections; fewer read at a glance. */
const CONTROLS_FROM = 5

export default function OwnerPage() {
  const { owner } = useParams()
  const [params] = useSearchParams()
  const { currentUser } = useAppContext()
  const { account, collections, members, activity, origin } = useLoaderData() as {
    account: OrgAccount
    collections: OrgCollection[]
    members: OrgMember[]
    activity: OrgActivity[]
    origin: string
  }

  const isMember = currentUser?.orgs?.some((o: any) => o.slug === owner) ?? false
  // Members and KF admins see the settings link.
  const canManage = useIsOwner(owner)
  const slug = account.slug

  const pinned = useMemo(
    () =>
      collections
        .filter((c) => c.pinned !== null)
        .sort((a, b) => (a.pinned ?? 0) - (b.pinned ?? 0)),
    [collections],
  )

  // A tab shows only when there is something in it.
  const tabs: { id: OrgTab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
  ]
  if (collections.length)
    tabs.push({ id: 'collections', label: 'Collections', count: collections.length })
  if (members.length) tabs.push({ id: 'members', label: 'Members', count: members.length })
  if (activity.length) tabs.push({ id: 'activity', label: 'Activity' })
  const asked = params.get('tab') as OrgTab | null
  const tab: OrgTab = tabs.some((t) => t.id === asked) ? asked! : 'overview'

  // The command line example: a pinned collection, else the largest.
  const example =
    pinned.find((c) => c.latestVersion) ??
    collections
      .filter((c) => c.latestVersion)
      .sort((a, b) => (b.recordCount ?? 0) - (a.recordCount ?? 0))[0] ??
    null

  // Every org's page has the same shape: the collections it pinned, if any, as small
  // cards, then the list of all of them.
  const list = (
    <CollectionsBrowser
      owner={slug}
      collections={collections}
      newCollection={isMember}
      controls={collections.length >= CONTROLS_FROM}
    />
  )
  let main: React.ReactNode
  if (tab === 'collections') {
    main = list
  } else if (tab === 'members') {
    main = <MembersSection owner={slug} members={members} />
  } else if (tab === 'activity') {
    main = <ActivityList owner={slug} activity={activity} />
  } else if (collections.length === 0) {
    main = <NoCollections member={isMember} owner={slug} />
  } else {
    main = (
      <div className="flex flex-col gap-10">
        {pinned.length > 0 && (
          <section>
            <h2 className="text-ink-muted mb-3 text-xs font-semibold tracking-wide uppercase">
              Pinned
            </h2>
            <PinnedCards owner={slug} collections={pinned} />
          </section>
        )}
        {list}
      </div>
    )
  }

  return (
    <BaseLayout>
      <OrgHeader
        account={account}
        tabs={tabs}
        tab={tab}
        canManage={canManage}
        summary={orgSummary(collections)}
      />
      <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-x-10 gap-y-10 px-4 pt-8 pb-12">
        <div className="min-w-0 flex-[999_1_36rem]">{main}</div>
        <aside className="flex min-w-0 flex-[1_1_16rem] flex-col gap-8">
          {account.bio && <AboutSection bio={account.bio} />}
          {members.length > 0 && tab !== 'members' && (
            <MembersSection owner={slug} members={members} limit={8} />
          )}
          <UseThisData owner={slug} example={example} origin={origin} />
          {activity.length > 0 && tab !== 'activity' && (
            <ActivityList owner={slug} activity={activity} limit={5} />
          )}
        </aside>
      </div>
    </BaseLayout>
  )
}
