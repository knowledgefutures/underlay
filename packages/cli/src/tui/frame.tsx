/** What every screen of the terminal UI is drawn with: coloured lines, cards, and the key bar. */
import { Box, Text } from 'ink'
import type { ReactNode } from 'react'

import { C, type Key, type Line } from './lines.js'

const lineText = (l: Line) => l.segs.map((s) => s.t).join('')

export function Lines({ lines, width }: { lines: Line[]; width: number }) {
  return (
    <>
      {lines.map((l, i) => {
        const text = lineText(l)
        return (
          <Text key={i} wrap="truncate-end">
            {text === '' ? ' ' : null}
            {l.segs.map((s, j) =>
              s.t ? (
                <Text
                  key={j}
                  color={s.c ?? C.fg}
                  bold={!!s.b}
                  {...((s.bg ?? l.bg) ? { backgroundColor: s.bg ?? l.bg } : {})}
                >
                  {s.t}
                </Text>
              ) : null,
            )}
            {l.bg ? (
              <Text backgroundColor={l.bg}>{' '.repeat(Math.max(0, width - text.length))}</Text>
            ) : null}
          </Text>
        )
      })}
    </>
  )
}

/** A card: a rounded box whose top edge carries its title, as a fieldset's legend. */
export function Frame(props: {
  title: string
  meta?: string
  color?: string
  border?: string
  width: number
  height: number
  children?: ReactNode
}) {
  const { title, meta, color, border, width, height, children } = props
  const edge = border ?? C.dim
  const head = ` ${title} `
  const room = Math.max(0, width - 4 - head.length)
  const note =
    meta && room > 6 ? ` ${meta.length > room - 3 ? meta.slice(0, room - 4) + '…' : meta} ` : ''
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={edge}>╭─</Text>
        <Text color={color ?? C.fg} bold>
          {head}
        </Text>
        <Text color={C.mu}>{note}</Text>
        <Text color={edge}>{'─'.repeat(Math.max(0, room - note.length)) + '─╮'}</Text>
      </Text>
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderTop={false}
        borderColor={edge}
        paddingX={1}
        overflowY="hidden"
      >
        {children}
      </Box>
    </Box>
  )
}

/** The lines that fit, keeping a line in view. */
export function windowed(lines: Line[], rows: number, keep: number): Line[] {
  if (lines.length <= rows) return lines
  const start = Math.min(Math.max(0, keep - Math.floor(rows / 2)), lines.length - rows)
  return lines.slice(start, start + rows)
}

export function KeyBar({ keys, width }: { keys: Key[]; width: number }) {
  return (
    <Box width={width} flexWrap="wrap" columnGap={2}>
      {keys.map((k, i) => (
        <Text key={i} color={C.mu}>
          <Text color={C.fg} bold>
            {k.k}
          </Text>{' '}
          {k.l}
        </Text>
      ))}
    </Box>
  )
}
