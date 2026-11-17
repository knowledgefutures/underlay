/**
 * The woodpecker from Underlay's logo, as pixels drawn with half blocks: each text cell holds two
 * pixels, its top and bottom half. In a sprite, '#' is ink (the terminal's text colour, or the
 * UI's), 'r' the red crest, 'c' a wood chip, and '.' nothing. The large sizes are traced from the
 * logo; the small ones are placed by hand.
 */
import { getSetting } from '../core/config.js'
import type { Env } from '../core/env.js'
import { C, L, S, type Line, type Seg } from './lines.js'

export const CREST = '#e62224'
export const WOOD = '#c99a62'

export const BIRD = {
  /** 40 × 18 cells: the help screen. */
  XL: [
    '....######..............................',
    '.....#######............................',
    '......######rrr##.......................',
    '........###rrrrr#########...............',
    '........##rrrrrrr##########.............',
    '........##rrr########...................',
    '........##.....####.....................',
    '........##....####......................',
    '........##....###.......................',
    '........##....###.......................',
    '........##...#####......................',
    '........##...#######....................',
    '........##...########...................',
    '........##...#########..................',
    '........##...##########.................',
    '........##...############...............',
    '........##....############..............',
    '........##....#############.............',
    '........###....#############............',
    '........###.....##############..........',
    '.........##......##############.........',
    '.........###......##############........',
    '..........###........############.......',
    '...........###.................####.....',
    '............####................####....',
    '.............########################...',
    '..............#########################.',
    '..............#########################.',
    '.............###...####.................',
    '...........####...####..................',
    '..........####...####...................',
    '.........####...###.....................',
    '........###...####......................',
    '########################################',
    '########################################',
    '########################################',
  ],
  /** 24 × 11 cells: the welcome after underlay init. */
  L: [
    '..####..................',
    '...####rr##.............',
    '....##rrrr######........',
    '....##rr####............',
    '....##...##.............',
    '....##..##..............',
    '....##..###.............',
    '....##..####............',
    '....##..######..........',
    '....##..#######.........',
    '.....#..########........',
    '.....##..########.......',
    '.....##...#########.....',
    '......##...#########....',
    '......###..........##...',
    '........##############..',
    '........###############.',
    '.......###.###..........',
    '......###.###...........',
    '.....###.###............',
    '########################',
    '########################',
  ],
  /** 16 × 7 cells: beside a push or pull. */
  M: [
    '..###...........',
    '...#rr#####.....',
    '...#r.##........',
    '...#.##.........',
    '...#.###........',
    '...#.####.......',
    '...#.######.....',
    '...#..######....',
    '....#..######...',
    '.....##.....###.',
    '.....###########',
    '.....##.##......',
    '....##.##.......',
    '################',
  ],
  /** 10 × 4 cells. */
  S: [
    '.##.......',
    '..#r####..',
    '..#.##....',
    '..#.###...',
    '..#..###..',
    '...#######',
    '...#.#....',
    '##########',
  ],
} as const

export type Sprite = readonly string[]

/** Chips at [x, y], put on a sprite. */
function withChips(sprite: Sprite, chips: [number, number][]): string[] {
  return sprite.map((row, y) => {
    const a = row.split('')
    for (const [x, cy] of chips) if (cy === y) a[x] = 'c'
    return a.join('')
  })
}

const M = BIRD.M
/** The head dips a pixel forward and down; the body stays put. */
const DIP = [
  '.'.repeat(M[0].length),
  '.' + M[0].slice(0, -1),
  '.' + M[1].slice(0, -1),
  '.' + M[2].slice(0, -1),
  ...M.slice(4),
]

/** Pecking, one frame a tick: a peck, chips flying off, and back. */
export const PECK: Sprite[] = [
  DIP,
  withChips(M, [
    [12, 1],
    [14, 0],
  ]),
  M,
  withChips(M, [
    [13, 0],
    [15, 1],
  ]),
]

const paint = (ch: string | undefined, ink: string): string | null =>
  ch === '#' ? ink : ch === 'r' ? CREST : ch === 'c' ? WOOD : null

/** A sprite as the lines the terminal UI draws, two pixel rows to a line. */
export function birdLines(sprite: Sprite, ink: string = C.fg): Line[] {
  const out: Line[] = []
  for (let y = 0; y < sprite.length; y += 2) {
    const segs: Seg[] = []
    const row = sprite[y]!
    for (let x = 0; x < row.length; x++) {
      const top = paint(row[x], ink)
      const bot = paint(sprite[y + 1]?.[x], ink)
      const seg: Seg =
        !top && !bot
          ? S(' ')
          : top === bot
            ? S('█', top!)
            : !bot
              ? S('▀', top!)
              : !top
                ? S('▄', bot)
                : S('▀', top, false, bot)
      // Neighbours of one look make one segment, so Ink draws fewer spans.
      const last = segs.at(-1)
      if (last && last.c === seg.c && last.bg === seg.bg) last.t += seg.t
      else segs.push(seg)
    }
    out.push(L(segs))
  }
  return out
}

/** Lines of a sprite with lines of text beside them, a gap between. */
export function beside(bird: Line[], text: Line[], gap = 2): Line[] {
  const n = Math.max(bird.length, text.length)
  const w = bird[0]?.segs.reduce((a, s) => a + s.t.length, 0) ?? 0
  const out: Line[] = []
  for (let i = 0; i < n; i++)
    out.push(
      L([...(bird[i]?.segs ?? [S(' '.repeat(w))]), S(' '.repeat(gap)), ...(text[i]?.segs ?? [])]),
    )
  return out
}

// --- Plain commands: the same cells as ANSI, ink in the terminal's own text colour ---

export type Depth = 'truecolor' | '256'

const sgr = (hex: string, depth: Depth, bg = false): string => {
  if (depth === '256') {
    const n = hex === CREST ? 160 : 179
    return `${bg ? 48 : 38};5;${n}`
  }
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `${bg ? 48 : 38};2;${r};${g};${b}`
}

/**
 * A sprite as lines of ANSI text. Ink is the terminal's default foreground, so the bird is
 * right on light and dark terminals alike. A cell with ink in one half and a colour in the other
 * would need ink as a background, which ANSI cannot name; reverse video draws it instead.
 */
export function birdAnsi(sprite: Sprite, depth: Depth): string[] {
  const out: string[] = []
  for (let y = 0; y < sprite.length; y += 2) {
    let line = ''
    const row = sprite[y]!
    for (let x = 0; x < row.length; x++) {
      const t = row[x]!
      const b = sprite[y + 1]?.[x] ?? '.'
      const col = (ch: string) => (ch === 'r' ? CREST : WOOD)
      let cell: string
      if (t === '.' && b === '.') cell = ' '
      else if (t === b) cell = t === '#' ? '█' : `\x1b[${sgr(col(t), depth)}m█\x1b[0m`
      else if (b === '.') cell = t === '#' ? '▀' : `\x1b[${sgr(col(t), depth)}m▀\x1b[0m`
      else if (t === '.') cell = b === '#' ? '▄' : `\x1b[${sgr(col(b), depth)}m▄\x1b[0m`
      else if (t === '#') cell = `\x1b[7;39;${sgr(col(b), depth, true)}m▄\x1b[0m`
      else if (b === '#') cell = `\x1b[7;39;${sgr(col(t), depth, true)}m▀\x1b[0m`
      else cell = `\x1b[${sgr(col(t), depth)};${sgr(col(b), depth, true)}m▀\x1b[0m`
      line += cell
    }
    out.push(line.replace(/ +$/, ''))
  }
  return out
}

/** Whether to draw the bird on a stream: a terminal, colour allowed, UTF-8, and not turned off. */
export function mascotOn(
  env: Env,
  stream: { isTTY?: boolean; columns?: number },
  vars: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!stream.isTTY) return false
  if (vars.NO_COLOR !== undefined && vars.NO_COLOR !== '') return false
  if (vars.TERM === 'dumb') return false
  const locale = vars.LC_ALL || vars.LC_CTYPE || vars.LANG
  if (locale && !/utf-?8/i.test(locale)) return false
  try {
    return getSetting(env, 'mascot').value !== 'off'
  } catch {
    return true
  }
}

/** How many colours to use for the crest outside the terminal UI. */
export const depthOf = (vars: NodeJS.ProcessEnv = process.env): Depth =>
  /truecolor|24bit/i.test(vars.COLORTERM ?? '') ? 'truecolor' : '256'

/** The width a line of ANSI text takes on screen. */
// oxlint-disable-next-line no-control-regex
export const visibleWidth = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length
