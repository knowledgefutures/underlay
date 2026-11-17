/**
 * The new-collection form: one form used three ways, from n in Collections, from a file that
 * matches nothing here, and from a run that wrote a collection that isn't here. Those fill in
 * what they know. A new collection starts on this machine: no server, org or access to choose.
 * Choosing a server instead asks for those, and signs in there if you aren't.
 *
 * The same form publishes a local collection (p on it): the server, org, name and access it
 * takes there. Publishing moves it, and the push screen follows.
 */
import type { CollectionMeta } from '../core/home.js'
import { blank, C, caps, L, type Line, P, type Pane, S } from './lines.js'

export type NewField = 'server' | 'key' | 'org' | 'name' | 'title' | 'type' | 'access'

export interface NewForm {
  /** The servers to choose from; '' is this machine, offered when making one, not publishing. */
  servers: string[]
  /** '' for this machine. */
  server: string
  /** Signed in to the server: false asks for a key in place of the org. */
  signedIn: boolean
  /** Where a key comes from, when signed out. */
  keyUrl: string
  /** A key being pasted, to sign in with. */
  key: string
  /** Your orgs on the server; null when not read yet (the org is typed instead). */
  orgs: string[] | null
  org: string
  name: string
  title: string
  /** The type its records take, when it starts from a file or a run. */
  type: string | null
  access: 'private' | 'public'
  field: NewField
  /** What it starts from, for the title's note: "from roster-2026.csv". */
  from: string | null
  /** What enter does after making it: "make it, then shape its schema". */
  then: string | null
  /** The local collection being published, when the form publishes. */
  publishing: CollectionMeta | null
  /** How many versions it has, said in the publish note. */
  versions?: number
}

export const isLocalForm = (f: NewForm) => f.server === ''

export const fieldsOf = (f: NewForm): NewField[] => [
  'server',
  ...(isLocalForm(f) ? [] : f.signedIn ? (['org'] as const) : (['key'] as const)),
  'name',
  ...(f.type !== null ? (['type'] as const) : []),
  'title',
  ...(isLocalForm(f) ? [] : (['access'] as const)),
]

/** Fields typed into, rather than chosen with ←→ or space. */
export const typedField = (f: NewForm, field: NewField) =>
  field === 'name' ||
  field === 'title' ||
  field === 'type' ||
  field === 'key' ||
  (field === 'org' && !f.orgs)

/** The collection the form names, as `new` and `publish` take it. */
export const formKey = (f: NewForm) => (isLocalForm(f) ? f.name : `${f.server}/${f.org}/${f.name}`)

export function newPane(f: NewForm, problem: string | null, width: number): Pane {
  const local = isLocalForm(f)
  const row = (field: NewField, value: string, hint: string, valueColor: string = C.fg): Line => {
    const on = f.field === field
    const shown = on && typedField(f, field) ? value + '▏' : value || (on ? '▏' : '')
    return L(
      [
        S(on ? '▌ ' : '  ', C.bl),
        S(P(field, 9), C.mu),
        S(P(shown, 24), on ? C.wh : valueColor, on),
        S(hint, C.mu),
      ],
      on ? C.sel : undefined,
    )
  }
  const choices = f.servers.length > 1
  const lines: Line[] = [
    row(
      'server',
      f.server || 'this machine',
      choices ? (f.publishing ? '←→ your servers' : '←→ this machine or a server') : '',
      C.bl,
    ),
  ]
  if (!local && f.signedIn)
    lines.push(
      row(
        'org',
        f.org,
        f.orgs ? (f.orgs.length > 1 ? '←→ your orgs there' : '') : 'your org there',
        C.bl,
      ),
    )
  if (!local && !f.signedIn)
    lines.push(row('key', '•'.repeat(Math.min(f.key.length, 22)), 'paste a key; enter signs in'))
  lines.push(
    row(
      'name',
      f.name,
      f.from ? `from ${f.from.includes('run') ? 'what the run named' : "the file's name"}` : '',
    ),
  )
  if (f.type !== null)
    lines.push(row('type', f.type, `one type per sheet; its records are ${f.type || 'records'}s`))
  lines.push(row('title', f.title, local ? 'optional' : `shown on ${f.server}; optional`))
  if (!local)
    lines.push(
      row('access', f.access, 'space: private or public', f.access === 'public' ? C.or : C.fg),
    )
  lines.push(blank())
  if (!local && !f.signedIn)
    lines.push(
      L([S(`  Not signed in to ${f.server}. Make a key at`, C.mu)]),
      L([S(`  ${f.keyUrl}`), S(' and paste it above.', C.mu)]),
      blank(),
    )
  const key = `${f.server}/${f.org || '<org>'}/${f.name || '<name>'}`
  if (f.publishing) {
    const n = f.versions ?? 0
    lines.push(
      L([S(`  Moves ${f.publishing.name} to ${key}. Then the push screen sends`, C.mu)]),
      L([
        S(
          `  ${n ? `its ${n} version${n === 1 ? '' : 's'}` : 'it'}, unchanged, and creates it on ${f.server}.`,
          C.mu,
        ),
      ]),
    )
  } else if (local)
    lines.push(
      L([S(`  Makes ${f.name || '<name>'} on this machine. Choose a server only when you`, C.mu)]),
      L([S('  want one: p on it publishes it, with its versions.', C.mu)]),
    )
  else
    lines.push(
      L([S(`  Makes ${key} here. Nothing leaves this machine until you push;`, C.mu)]),
      L([S(`  the first push creates it on ${f.server}.`, C.mu)]),
    )
  if (problem) lines.push(blank(), L([S(`  ${problem}`, C.or)]))
  const enter =
    f.field === 'key' && f.key
      ? 'sign in'
      : f.publishing
        ? 'publish, then push'
        : (f.then ?? 'make it')
  const keys = [
    { k: 'enter', l: enter },
    { k: 'tab', l: 'next field' },
    { k: 'esc', l: 'cancel' },
  ]
  lines.push(blank(), ...caps(keys, width - 2))
  return {
    title: f.publishing ? `Publish ${f.publishing.name}` : 'New collection',
    meta: f.from ? `from ${f.from}` : 'esc cancels',
    lines,
    keys,
  }
}
