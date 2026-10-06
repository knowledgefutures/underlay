import { useMemo } from 'react'

import { useAppContext } from '~/lib/app-context'

/**
 * Whether the current user can administer collections under `owner`:
 * their personal account, an org they belong to, or KF admin.
 * One definition so the Settings tab doesn't appear and disappear
 * between collection pages.
 */
export function useIsOwner(owner: string | undefined): boolean {
  const { currentUser } = useAppContext()
  return useMemo(
    () =>
      !!currentUser &&
      (currentUser.kfRole === 'admin' ||
        currentUser.slug === owner ||
        !!currentUser.orgs?.some((o: { slug: string }) => o.slug === owner)),
    [currentUser, owner],
  )
}
