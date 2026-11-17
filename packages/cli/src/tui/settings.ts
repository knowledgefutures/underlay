/**
 * The settings screen, laid out as Hopper's is: every setting in a list grouped into sections on
 * the left, and on the right what the selected one is, whether it is set or a default, and how to
 * change it. config.toml stays the truth and can be edited by hand (o).
 */
import { blank, C, L, type Key, type Line, S, wrap } from './lines.js'
import type { SettingRow } from './screens.js'

export const GROUPS = [
  'Home',
  'Store',
  'Rules',
  'Remotes',
  'Script folders',
  'Handoff',
  'Serve',
  'Terminal',
] as const

/** What a section is for, shown in About when the section's own row is selected. */
const GROUP_HELP: Record<string, string> = {
  Home: 'Where your collections, the inputs scripts read, and your own scripts are.',
  Store:
    'Where record files, versions not yet pushed, and run logs are kept, and how much fetched data may be.',
  Rules:
    'Rules send a collection’s records somewhere other than the store, or set how much of it is kept, by authority, org or collection. The most specific match wins.',
  Remotes:
    'The places collections come from and are pushed to. underlay login <remote> signs in to one with a key from its settings page.',
  'Script folders':
    'Folders of scripts: home’s scripts/, the folders listed in config.toml, and the one you are in when it has an underlay.toml.',
  Handoff: 'Where a handoff prompt for an agent goes.',
  Serve: 'Views served on this machine.',
  Terminal: 'How the CLI looks in a terminal.',
}

/** Sections that a adds to, and what it asks for. */
export const ADDS: Record<string, string> = {
  Rules: 'a adds one.',
  Remotes: 'a adds one by name and URL.',
  'Script folders': 'a adds a folder by its path.',
}

export type SettingsItem = { kind: 'section'; group: string } | { kind: 'row'; row: SettingRow }

/** The list as shown: each section, then its rows. Sections that take additions show even empty. */
export function settingsItems(rows: SettingRow[]): SettingsItem[] {
  const out: SettingsItem[] = []
  for (const g of GROUPS) {
    const mine = rows.filter((r) => r.group === g)
    if (!mine.length && !ADDS[g]) continue
    out.push({ kind: 'section', group: g })
    for (const row of mine) out.push({ kind: 'row', row })
  }
  return out
}

/** The section an item is in. */
export const groupOf = (it: SettingsItem | undefined) =>
  !it ? '' : it.kind === 'section' ? it.group : it.row.group

const LABEL_MAX = 26

/** Whether a row can be edited with enter, and whether d does anything. */
export const editable = (r: SettingRow) => r.kind !== 'info' && r.kind !== 'source'
export const resettable = (r: SettingRow) =>
  r.kind === 'rule' ||
  r.kind === 'source' ||
  ((r.kind === 'setting' || r.kind === 'remote') && r.from === 'set')

export function settingsList(
  items: SettingsItem[],
  cursor: number,
  editing: string | null,
): Line[] {
  const labelW = Math.min(
    LABEL_MAX,
    Math.max(12, ...items.map((it) => (it.kind === 'row' ? it.row.label.length + 2 : 0))),
  )
  return items.map((it, i) => {
    const on = i === cursor
    const rail = S(on ? '▌' : ' ', C.bl)
    if (it.kind === 'section')
      return L([rail, S(it.group.toUpperCase(), C.wh, true)], on ? C.sel : undefined)
    const r = it.row
    const label = (r.label.length >= labelW ? r.label.slice(0, labelW - 2) + '…' : r.label).padEnd(
      labelW,
    )
    const isSet = r.from === 'set'
    const value =
      on && editing !== null ? S(editing + '▏', C.wh) : S(r.value || '—', isSet ? C.fg : C.mu)
    const note = on && editing !== null ? '' : isSet ? '' : `  ${r.from}`
    return L(
      [rail, S('    ' + label, C.mu), value, ...(note ? [S(note, C.dim)] : [])],
      on ? C.sel : undefined,
    )
  })
}

/** The About panel: the selected row, what it does, and how to change it. */
export function settingsAbout(
  it: SettingsItem | undefined,
  file: string,
  width: number,
  editing: boolean,
): Line[] {
  if (!it) return [L([S('Nothing here.', C.mu)])]
  const out: Line[] = []
  if (it.kind === 'section') {
    out.push(L([S(it.group, C.wh, true)]), blank())
    out.push(...wrap(GROUP_HELP[it.group] ?? '', width))
    const add = ADDS[it.group]
    if (add) out.push(blank(), L([S(add, C.mu)]))
  } else {
    const r = it.row
    out.push(L([S(r.label, C.wh, true)]))
    out.push(
      L([
        S(r.value || '—', r.from === 'set' ? C.fg : C.mu),
        S(`  ${r.from === 'set' ? 'set' : r.from}`, C.mu),
      ]),
      blank(),
    )
    out.push(...wrap(r.help ?? r.about, width))
    const how = editing
      ? 'enter saves; esc leaves it as it was.'
      : r.kind === 'info'
        ? r.from === 'env'
          ? 'Set in the environment, not in config.toml.'
          : 'Found, not set: nothing to change here.'
        : r.kind === 'source'
          ? 'd takes it out of config.toml; its files stay.'
          : r.kind === 'rule'
            ? 'enter edits it: path <folder>, keep all, some or none. d removes it.'
            : r.choices
              ? `enter steps through: ${r.choices.join(', ')}.${r.from === 'set' ? ' d goes back to the default.' : ''}`
              : `enter edits it.${r.from === 'set' ? ' d goes back to the default.' : ''}`
    out.push(blank(), ...wrap(how, width, C.mu))
  }
  out.push(blank(), L([S(file, C.dim)]))
  return out
}

export function settingsKeys(it: SettingsItem | undefined, editing: boolean): Key[] {
  if (editing)
    return [
      { k: 'enter', l: 'save' },
      { k: 'esc', l: 'cancel' },
    ]
  const keys: Key[] = [
    { k: '↑↓', l: 'move' },
    { k: 'J K', l: 'sections' },
  ]
  const r = it?.kind === 'row' ? it.row : null
  if (r && editable(r)) keys.push({ k: 'enter', l: r.choices ? 'next choice' : 'edit' })
  if (r && resettable(r))
    keys.push({ k: 'd', l: r.kind === 'rule' || r.kind === 'source' ? 'remove' : 'default' })
  if (ADDS[groupOf(it)]) keys.push({ k: 'a', l: 'add' })
  keys.push({ k: 'o', l: 'open config.toml' }, { k: 'esc', l: 'close' })
  return keys
}
