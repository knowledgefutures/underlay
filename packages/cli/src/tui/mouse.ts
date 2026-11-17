/**
 * Mouse input, as Hopper reads it. With reporting on, the terminal sends clicks, the wheel, and
 * movement as SGR sequences, ESC [ < button ; column ; row M (press) or m (release), 1-based.
 * 1003 reports every movement (for hover), 1006 is SGR. Holding Option (iTerm) or Shift (most
 * others) still selects text.
 */
export const MOUSE_ON = '\x1b[?1003h\x1b[?1006h'
export const MOUSE_OFF = '\x1b[?1003l\x1b[?1006l'

export interface MouseEvent {
  kind: 'wheel-up' | 'wheel-down' | 'press' | 'drag' | 'move' | 'release' | 'other'
  x: number
  y: number
}

// Ink hands the sequence over as text without its ESC.
const SGR = /\[<(\d+);(\d+);(\d+)([Mm])/g

/** The mouse events in a piece of input, or null when it is keys. */
export function parseMouse(input: string): MouseEvent[] | null {
  const events: MouseEvent[] = []
  for (const m of input.matchAll(SGR)) {
    const button = Number(m[1])
    const base = button & ~(4 | 8 | 16) // shift, meta and ctrl
    const kind: MouseEvent['kind'] =
      base === 64
        ? 'wheel-up'
        : base === 65
          ? 'wheel-down'
          : base >= 32 && base <= 34
            ? 'drag'
            : base === 35
              ? 'move'
              : base <= 2
                ? m[4] === 'm'
                  ? 'release'
                  : 'press'
                : 'other'
    events.push({ kind, x: Number(m[2]), y: Number(m[3]) })
  }
  return events.length ? events : null
}
