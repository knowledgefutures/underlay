/**
 * The help screen (?), laid out as Hopper's is: every key, in sections set as columns, a heading
 * then one key a line, keys right-aligned against what they do. The section for where you were
 * when you pressed ? is lit. Beside the keys, when there is room and the mascot is on, the
 * woodpecker, with the version and where things are.
 */
import { BIRD, birdLines } from './bird.js'
import { blank, C, L, type Line, S } from './lines.js'

export type Section =
  | 'anywhere'
  | 'a collection'
  | 'a script'
  | 'a view'
  | 'a run'
  | 'push'
  | 'adding from a remote'
  | 'a file'
  | 'settings'

type Hint = [key: string, does: string]

export const SECTIONS: [Section, Hint[]][] = [
  [
    'anywhere',
    [
      ['c', 'collections on this machine'],
      ['s', 'servers: enter on one adds from it'],
      ['r', 'scripts and views'],
      ['↑↓', 'move in that card'],
      ['tab', 'the card or the pane beside it'],
      ['enter', 'open'],
      ['esc', 'back to collections'],
      ['+', 'a new collection'],
      ['p', 'push the selected collection'],
      ['P', 'push every collection'],
      ['h', 'all runs'],
      ['f', 'add a file, or drop one'],
      [',', 'settings'],
      ['?', 'these keys'],
      ['x x', 'quit'],
    ],
  ],
  [
    'a collection',
    [
      ['←→', 'tabs'],
      ['↑↓', 'in the pane: scroll, or choose'],
      ['enter', 'open a record or a file'],
      ['w', 'save a file to Downloads (Files)'],
      ['l', 'pull'],
      ['u', 'undo last change'],
      ['k', 'keep everything, data, or metadata'],
      ['R', 'run its script'],
      ['o', 'open on its authority'],
      ['D', 'remove from this machine (asks)'],
      ['a', 'copy a prompt for an agent'],
      ['A', 'send it (handoff.send)'],
      ['n', 'next page of records'],
      ['↑↓', 'choose a version (Versions)'],
      ['S', 'squash not pushed (Versions)'],
      ['e', 'reword newest (Versions)'],
    ],
  ],
  [
    'a script',
    [
      ['R', 'run'],
      ['h', 'all runs'],
    ],
  ],
  [
    'a view',
    [
      ['v', 'open in a browser'],
      ['X', 'stop serving'],
    ],
  ],
  [
    'a run',
    [
      ['X', 'cancel'],
      ['space', 'pause or resume'],
      ['R', 'restart, or run again'],
      ['u', 'undo a finished run'],
      ['n', "make a collection it wrote that isn't here"],
      ['enter', 'full output'],
      ['a', 'prompt for an agent'],
      ['esc', 'back; it keeps running'],
    ],
  ],
  [
    'push',
    [
      ['space', 'include or leave out'],
      ['d', 'changes'],
      ['e', 'edit a message'],
      ['S', 'squash here first'],
      ['y', 'push'],
      ['push ⏎', 'push, where it asks'],
      ['esc', 'cancel'],
    ],
  ],
  [
    'adding from a remote',
    [
      ['space', 'select'],
      ['k', 'everything, data, or metadata'],
      ['←→', 'fold an org'],
      ['tab', 'your orgs or public'],
      ['/', 'search'],
      ['enter', 'add'],
    ],
  ],
  [
    'a file',
    [
      ['n', 'a new collection from it'],
      ['tab', 'next option'],
      ['←→', "change it, or a column's type"],
      ['space', 'keep or leave out a column'],
      ['e', 'edit the drafted schema'],
      ['enter', 'run the import'],
      ['x', 'eject to a .ts to edit'],
      ['A', 'hand to an agent'],
    ],
  ],
  [
    'settings',
    [
      ['↑↓', 'move'],
      ['J K', 'sections'],
      ['enter', 'edit, or next choice'],
      ['d', 'default, or remove'],
      ['a', 'add to this section'],
      ['o', 'open config.toml'],
      ['esc', 'close'],
    ],
  ],
]

const GAP = 4
const MIN_COL = 34
const MAX_COLS = 3
const BIRD_W = BIRD.XL[0].length
const BIRD_H = BIRD.XL.length / 2

const sectionH = (hints: Hint[]) => hints.length + 2

/** Split the sections, in order, into at most n columns, as even in height as they go. */
function columns(n: number): number[][] {
  const hs = SECTIONS.map(([, h]) => sectionH(h))
  const total = hs.reduce((a, b) => a + b, 0)
  for (let cap = Math.max(...hs, Math.ceil(total / n)); ; cap++) {
    const cols: number[][] = [[]]
    let used = 0
    hs.forEach((h, i) => {
      if (used + h > cap && cols.at(-1)!.length) {
        cols.push([])
        used = 0
      }
      cols.at(-1)!.push(i)
      used += h
    })
    if (cols.length <= n) return cols
  }
}

export interface HelpInfo {
  version: string
  home: string
  config: string
  mascot: boolean
}

export interface HelpView {
  /** The bird and what is under it, or null when there is no room or it is turned off. */
  side: Line[] | null
  sideW: number
  cols: Line[][]
  colW: number
  gap: number
  /** How far it scrolls, and how far it is scrolled. */
  maxScroll: number
  top: number
  foot: Line[]
}

/** The help screen for an inner width and height (inside the frame). */
export function helpView(
  here: Section,
  info: HelpInfo,
  width: number,
  height: number,
  /** Lines scrolled; null scrolls to where you are. */
  scroll: number | null,
): HelpView {
  const foot: Line[] = [blank(), L([S(`config ${info.config} · home ${info.home}`, C.dim)])]
  const bodyH = Math.max(1, height - foot.length)
  const withBird = info.mascot && width - BIRD_W - GAP >= MIN_COL && bodyH >= BIRD_H + 3
  const room = withBird ? width - BIRD_W - GAP : width
  const n = Math.max(1, Math.min(MAX_COLS, Math.floor((room + GAP) / (MIN_COL + GAP))))
  const split = columns(n)
  const colW = Math.floor((room - GAP * (split.length - 1)) / split.length)
  // Where the lit section starts in its column, and how tall it is.
  let litAt = 0
  let litH = 0
  const built = split.map((col) => {
    const keyW = Math.max(...col.flatMap((i) => SECTIONS[i]![1].map(([k]) => k.length)))
    const lines: Line[] = []
    for (const i of col) {
      const [label, hints] = SECTIONS[i]!
      const lit = label === here
      if (lit) [litAt, litH] = [lines.length, sectionH(hints)]
      lines.push(
        L([
          S(label.toUpperCase(), lit ? C.bl : C.mu, true),
          ...(lit ? [S('  you are here', C.mu)] : []),
        ]),
      )
      for (const [k, d] of hints)
        lines.push(L([S(k.padStart(keyW), C.wh, true), S('  ' + d, C.fg)]))
      lines.push(blank())
    }
    return lines
  })
  const tallest = Math.max(...built.map((c) => c.length))
  const maxScroll = Math.max(0, tallest - 1 - bodyH)
  const want = scroll ?? (litAt + litH <= bodyH ? 0 : litAt)
  const top = Math.max(0, Math.min(want, maxScroll))
  const side = withBird
    ? [
        ...birdLines(BIRD.XL),
        blank(),
        L([S('Underlay ', C.wh, true), S(info.version, C.mu)]),
        L([S('underlay.org/docs/cli', C.bl)]),
      ]
    : null
  if (!withBird)
    foot[1] = L([S(`Underlay ${info.version} · underlay.org/docs/cli · `, C.mu), ...foot[1]!.segs])
  return {
    side,
    sideW: BIRD_W,
    cols: built.map((c) => c.slice(top, top + bodyH)),
    colW,
    gap: GAP,
    maxScroll,
    top,
    foot,
  }
}
