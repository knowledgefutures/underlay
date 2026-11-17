/**
 * The terminal UI draws every pane as lines of coloured segments, as the mockup does
 * (Underlay Local mockup, Terminal page): a pane is a title, a note, its lines, and its keys.
 */

/** The mockup's palette: warm text on a dark ground. */
export const C = {
  fg: '#e9e3d6',
  mu: '#8f8a7e',
  gr: '#8cc47a',
  bl: '#8bb8dc',
  or: '#e0a35c',
  rd: '#e8907f',
  wh: '#ffffff',
  sel: '#3a3830',
  /** A key cap's ground, as Hopper draws the keys in a pane. */
  cap: '#3d3a33',
  bg: '#1a1a18',
  dim: '#4a4740',
} as const

export interface Seg {
  t: string
  c?: string
  b?: boolean
  bg?: string
}

export interface Line {
  segs: Seg[]
  bg?: string
}

export const S = (t: string, c: string = C.fg, b = false, bg?: string): Seg => ({
  t,
  c,
  b,
  ...(bg ? { bg } : {}),
})
export const L = (segs: Seg[], bg?: string): Line => ({ segs, ...(bg ? { bg } : {}) })
export const blank = (): Line => L([S('')])
export const head = (t: string, note?: string): Line =>
  L([S(t, C.mu), ...(note ? [S('  ' + note, C.mu)] : [])])

export const P = (s: string | number, n: number) => {
  const t = String(s)
  return t.length >= n ? t : t + ' '.repeat(n - t.length)
}
export const R = (s: string | number, n: number) => {
  const t = String(s)
  return t.length >= n ? t : ' '.repeat(n - t.length) + t
}

/** The colour a status glyph takes. */
export const markColor = (m: string) =>
  m === '✓' || m === '●'
    ? C.gr
    : m === '✗'
      ? C.rd
      : m === '▶' || m === '‖'
        ? C.bl
        : m === '○'
          ? C.mu
          : C.fg

export interface Key {
  k: string
  l: string
}

export interface Pane {
  title: string
  meta?: string
  /** The title's colour: blue for what is live, green for done, orange for the loud step. */
  color?: string
  border?: string
  lines: Line[]
  keys: Key[]
  /** A line kept at the bottom of the pane, under its scrolling lines. */
  footer?: Line[]
}

/** Wrap plain text to a width, as lines. */
export function wrap(text: string, width: number, c: string = C.fg): Line[] {
  const out: Line[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (!word) continue
      if (line && line.length + 1 + word.length > width) {
        out.push(L([S(line, c)]))
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    out.push(L([S(line, c)]))
  }
  return out
}

export const rule = (width: number) => L([S('─'.repeat(Math.max(0, width)), C.dim)])

/**
 * Keys drawn in a pane as Hopper draws them: each key on its own ground, then what it does,
 * wrapped to the width.
 */
export function caps(keys: Key[], width: number): Line[] {
  const out: Line[] = []
  let segs: Seg[] = []
  let used = 0
  for (const k of keys) {
    const w = k.k.length + 2 + 1 + k.l.length + 3
    if (used && used + w > width) {
      out.push(L(segs))
      segs = []
      used = 0
    }
    segs.push(S(` ${k.k} `, C.fg, false, C.cap), S(` ${k.l}   `, C.mu))
    used += w
  }
  if (segs.length) out.push(L(segs))
  return out
}
