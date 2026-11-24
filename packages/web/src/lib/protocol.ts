/**
 * The protocol's specifications live one file a version, `docs/protocol/v<N>.md`, and its
 * pages one folder a version, `/docs/protocol/v<N>/…`; `/docs/protocol` leads to the current.
 * A page names the sections it restates with `protocolSections`, so its label always cites
 * its own version's file; a test (packages/protocol/test/protocol-refs.test.ts) checks that
 * each section named exists there.
 */

/** The version `/docs/protocol` leads to. */
export const CURRENT_PROTOCOL = 3

const isNumber = (s: string) => /^\d+$/.test(s)

/** "Section 8", "Sections 2 to 5", "Sections 6, 7, and 10", "Sections 9 and 12, and Appendix C". */
export function protocolSections(_version: number, sections: string[]): string {
  const numbers = sections.filter(isNumber)
  const appendices = sections.filter((s) => !isNumber(s))
  const list = (items: string[]) =>
    items.length <= 2
      ? items.join(' and ')
      : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
  const n = numbers.map(Number)
  const run = n.length >= 3 && n.every((x, i) => i === 0 || x === n[i - 1]! + 1)
  const parts: string[] = []
  if (numbers.length === 1) parts.push(`Section ${numbers[0]}`)
  else if (run) parts.push(`Sections ${n[0]} to ${n.at(-1)}`)
  else if (numbers.length > 1) parts.push(`Sections ${list(numbers)}`)
  if (appendices.length) parts.push(list(appendices))
  return parts.join(', and ')
}

/** A protocol page's label: "Protocol v3 · Sections 2 to 5". */
export const protocolEyebrow = (version: number, sections: string[]) =>
  `Protocol v${version} · ${protocolSections(version, sections)}`
