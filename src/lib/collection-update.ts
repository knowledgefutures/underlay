/**
 * Who may change what in `PATCH /collections/:owner/:slug`.
 *
 * `public` and `slug` decide who can see a collection and where it lives (URLs,
 * ARKs and links in the wild), so changing either needs owner/admin and a
 * non-collection-scoped key. `name` stays open to any org member. Fields that
 * are sent but equal the stored value are not changes: the settings page sends
 * `name` and `public` on every save.
 */

export interface CollectionUpdate {
  name?: string | undefined
  slug?: string | undefined
  public?: boolean | undefined
}

export interface CollectionCurrent {
  slug: string
  public: boolean
}

/** Fields in `updates` that would actually change `current` and need elevated rights. */
export function restrictedChanges(
  updates: CollectionUpdate,
  current: CollectionCurrent,
): Array<'slug' | 'public'> {
  const fields: Array<'slug' | 'public'> = []
  if (updates.slug !== undefined && updates.slug !== current.slug) fields.push('slug')
  if (updates.public !== undefined && updates.public !== current.public) fields.push('public')
  return fields
}

/** Returns an error message when the caller may not make these changes, else null. */
export function checkRestrictedChanges(
  fields: string[],
  caller: { role: string | null; keyScoped: boolean },
): string | null {
  if (fields.length === 0) return null
  if (caller.keyScoped) {
    return `API key is scoped to specific collections and cannot change ${fields.join(' or ')}`
  }
  if (caller.role !== 'owner' && caller.role !== 'admin') {
    return `Changing ${fields.join(' or ')} requires owner or admin role`
  }
  return null
}
