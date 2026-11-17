/**
 * A terminal frame (text with truecolor SGR escapes, as Ink writes it) drawn as an SVG of a
 * terminal window. Each run of same-styled text is placed at its column and stretched to its
 * cells (`textLength`), so the grid holds whatever monospace font the viewer has.
 */
interface Style {
  fg: string | null
  bg: string | null
  bold: boolean
}

interface Run extends Style {
  col: number
  text: string
}

const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')

/** The runs of each line of a frame. */
export function parseFrame(frame: string): Run[][] {
  const lines: Run[][] = []
  let style: Style = { fg: null, bg: null, bold: false }
  for (const raw of frame.replace(/\n$/, '').split('\n')) {
    const runs: Run[] = []
    let col = 0
    let i = 0
    const push = (ch: string) => {
      const last = runs.at(-1)
      if (
        last &&
        last.fg === style.fg &&
        last.bg === style.bg &&
        last.bold === style.bold &&
        last.col + [...last.text].length === col
      )
        last.text += ch
      else runs.push({ ...style, col, text: ch })
      col++
    }
    while (i < raw.length) {
      if (raw[i] === '\u001B' && raw[i + 1] === '[') {
        const end = raw.slice(i).search(/[A-Za-z]/)
        const body = raw.slice(i + 2, i + end)
        const cmd = raw[i + end]
        i += end + 1
        if (cmd !== 'm') continue
        const codes = body === '' ? [0] : body.split(';').map(Number)
        for (let k = 0; k < codes.length; k++) {
          const c = codes[k]!
          if (c === 0) style = { fg: null, bg: null, bold: false }
          else if (c === 1) style = { ...style, bold: true }
          else if (c === 22) style = { ...style, bold: false }
          else if (c === 39) style = { ...style, fg: null }
          else if (c === 49) style = { ...style, bg: null }
          else if ((c === 38 || c === 48) && codes[k + 1] === 2) {
            const color = hex(codes[k + 2]!, codes[k + 3]!, codes[k + 4]!)
            style = c === 38 ? { ...style, fg: color } : { ...style, bg: color }
            k += 4
          }
        }
        continue
      }
      const cp = raw.codePointAt(i)!
      const ch = String.fromCodePoint(cp)
      i += ch.length
      push(ch)
    }
    lines.push(runs)
  }
  return lines
}

const BOX = new Set(['─', '│', '╭', '╮', '╰', '╯'])
/** Half and full blocks, which a terminal fills to the cell's edges: the woodpecker is drawn in them. */
const BLOCK = new Set(['▀', '▄', '█'])

/** A box-drawing character as a path in its cell, rounded corners as quarter circles. */
function boxPath(ch: string, x: number, y: number, w: number, h: number): string | null {
  const mx = (x + w / 2).toFixed(1)
  const my = (y + h / 2).toFixed(1)
  const r = (w / 2).toFixed(1)
  const f = (n: number) => n.toFixed(1)
  switch (ch) {
    case '─':
      return `M${f(x)} ${my}H${f(x + w)}`
    case '│':
      return `M${mx} ${f(y)}V${f(y + h)}`
    case '╭':
      return `M${f(x + w)} ${my}H${f(x + w)}A${r} ${r} 0 0 0 ${mx} ${f(y + h / 2 + w / 2)}V${f(y + h)}`
    case '╮':
      return `M${f(x)} ${my}A${r} ${r} 0 0 1 ${mx} ${f(y + h / 2 + w / 2)}V${f(y + h)}`
    case '╰':
      return `M${mx} ${f(y)}V${f(y + h / 2 - w / 2)}A${r} ${r} 0 0 0 ${f(x + w)} ${my}`
    case '╯':
      return `M${mx} ${f(y)}V${f(y + h / 2 - w / 2)}A${r} ${r} 0 0 1 ${f(x)} ${my}`
    default:
      return null
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export interface SvgOptions {
  title: string
  columns: number
  rows: number
  background: string
  foreground: string
}

/** The frame inside a window: a title bar with three dots, then the terminal. */
export function frameToSvg(frame: string, o: SvgOptions): string {
  const cw = 8.4
  const lh = 19
  const fs = 14
  const pad = 18
  const bar = 34
  const width = Math.round(o.columns * cw + pad * 2)
  const height = Math.round(o.rows * lh + pad * 2 + bar)
  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(o.title)}">`,
    `<title>${esc(o.title)}</title>`,
    `<rect width="${width}" height="${height}" rx="10" fill="${o.background}"/>`,
    `<path d="M0 10a10 10 0 0 1 10-10h${width - 20}a10 10 0 0 1 10 10v${bar - 10}h-${width}z" fill="#262521"/>`,
    `<line x1="0" y1="${bar}" x2="${width}" y2="${bar}" stroke="#33312c"/>`,
    ...['#ff5f57', '#febc2e', '#28c840'].map(
      (c, i) => `<circle cx="${20 + i * 20}" cy="${bar / 2}" r="6" fill="${c}"/>`,
    ),
    `<text x="${width / 2}" y="${bar / 2 + 4}" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="12" fill="#8f8a7e">${esc(o.title)}</text>`,
    `<g font-family="'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${fs}" xml:space="preserve">`,
  )
  const lines = parseFrame(frame).slice(0, o.rows)
  lines.forEach((runs, row) => {
    const y = bar + pad + row * lh
    for (const r of runs) {
      const n = [...r.text].length
      if (r.bg)
        out.push(
          `<rect x="${(pad + r.col * cw).toFixed(1)}" y="${y}" width="${(n * cw).toFixed(1)}" height="${lh}" fill="${r.bg}"/>`,
        )
    }
    // Box-drawing characters as lines, so borders join across rows with no gaps; blocks as
    // rectangles, so pixels meet as they do in a terminal.
    for (const r of runs) {
      ;[...r.text].forEach((ch, k) => {
        const x = pad + (r.col + k) * cw
        if (BLOCK.has(ch)) {
          const top = ch === '▄' ? y + lh / 2 : y
          const h = ch === '█' ? lh : lh / 2
          out.push(
            `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(cw + 0.3).toFixed(1)}" height="${(h + 0.3).toFixed(1)}" fill="${r.fg ?? o.foreground}" shape-rendering="crispEdges"/>`,
          )
          return
        }
        const d = boxPath(ch, x, y, cw, lh)
        if (d)
          out.push(
            `<path d="${d}" stroke="${r.fg ?? o.foreground}" stroke-width="1.2" fill="none"/>`,
          )
      })
    }
    for (const r of runs) {
      // Only the visible part, at its own column: spaces are cells, not text to lay out.
      const chars = [...r.text].map((c) => (BOX.has(c) || BLOCK.has(c) ? ' ' : c))
      const lead = chars.findIndex((c) => c !== ' ')
      if (lead < 0) continue
      let end = chars.length
      while (chars[end - 1] === ' ') end--
      const vis = chars.slice(lead, end)
      const text = vis.join('').replace(/ /g, '\u00A0')
      out.push(
        `<text xml:space="preserve" x="${(pad + (r.col + lead) * cw).toFixed(1)}" y="${y + lh - 5}" fill="${r.fg ?? o.foreground}"${r.bold ? ' font-weight="600"' : ''}${vis.length > 1 ? ` textLength="${(vis.length * cw).toFixed(1)}" lengthAdjust="spacing"` : ''}>${esc(text)}</text>`,
      )
    }
  })
  out.push('</g>', '</svg>')
  return out.join('\n') + '\n'
}
