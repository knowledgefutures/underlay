/** The woodpecker: its sprites, drawn as half blocks for the UI and as ANSI, and when it shows. */
import { describe, expect, it, vi } from 'vitest'

import { setSetting } from '../src/core/config.js'
import { BIRD, birdAnsi, birdLines, mascotOn, PECK, visibleWidth } from '../src/tui/bird.js'
import { Pecker } from '../src/tui/pecker.js'
import { world } from './world.js'

describe('the woodpecker', () => {
  it('has even rows of one width, two pixel rows to a line', () => {
    for (const sprite of [...Object.values(BIRD), ...PECK]) {
      expect(sprite.length % 2).toBe(0)
      expect(new Set(sprite.map((r) => r.length)).size).toBe(1)
      expect(sprite.join('')).toMatch(/^[#rc.]+$/)
    }
  })

  it('draws as many lines as half its rows, each as wide as the sprite', () => {
    const lines = birdLines(BIRD.M)
    expect(lines).toHaveLength(BIRD.M.length / 2)
    for (const l of lines) expect(l.segs.map((s) => s.t).join('')).toHaveLength(BIRD.M[0].length)
    // Ink over crest in one cell: the top half as text, the bottom as background.
    expect(lines.flatMap((l) => l.segs).some((s) => s.bg === '#e62224')).toBe(true)
  })

  it('writes ANSI with ink in the terminal’s own colour, and never wider than the sprite', () => {
    const ansi = birdAnsi(BIRD.L, 'truecolor')
    expect(ansi).toHaveLength(BIRD.L.length / 2)
    for (const l of ansi) expect(visibleWidth(l)).toBeLessThanOrEqual(BIRD.L[0].length)
    expect(ansi.join('')).not.toMatch(/38;2;(?!230;34;36)/)
    expect(birdAnsi(BIRD.S, '256').join('')).toContain('38;5;160')
  })

  it('shows only in a UTF-8 terminal with colour, unless turned off', async () => {
    const w = await world()
    const tty = { isTTY: true }
    const vars = { LANG: 'en_US.UTF-8' }
    expect(mascotOn(w.env, tty, vars)).toBe(true)
    expect(mascotOn(w.env, { isTTY: false }, vars)).toBe(false)
    expect(mascotOn(w.env, tty, { ...vars, NO_COLOR: '1' })).toBe(false)
    expect(mascotOn(w.env, tty, { LANG: 'C' })).toBe(false)
    expect(mascotOn(w.env, tty, { ...vars, TERM: 'dumb' })).toBe(false)
    setSetting(w.env, 'mascot', 'off')
    expect(mascotOn(w.env, tty, vars)).toBe(false)
    expect(() => setSetting(w.env, 'mascot', 'maybe')).toThrow(/on or off/)
  })
})

describe('pecking beside a push', () => {
  it('waits most of a second, then draws under the log and redraws in place', () => {
    vi.useFakeTimers()
    try {
      let out = ''
      const p = new Pecker(
        { write: (s: string) => ((out += s), true), columns: 100, isTTY: true },
        '256',
      )
      const file = { key: 'kf/journals', authority: 'underlay.org', direction: 'up' as const }
      p.file({ ...file, semver: 'v1.2.0', done: 1, total: 5 })
      expect(out).toBe('')
      vi.advanceTimersByTime(800)
      p.file({ ...file, semver: 'v1.2.0', done: 3, total: 5 })
      expect(out).toContain('Pushing kf/journals to underlay.org')
      expect(out).toContain('3 of 5 files')
      out = ''
      p.log('  v1.2.0 ✓ underlay.org')
      // Up over the bird and cleared, the line, then the bird again under it.
      expect(out.startsWith(`\x1b[${BIRD.M.length / 2}F\x1b[J  v1.2.0 ✓ underlay.org\n`)).toBe(true)
      out = ''
      p.stop()
      expect(out).toBe(`\x1b[${BIRD.M.length / 2}F\x1b[J\x1b[?25h`)
    } finally {
      vi.useRealTimers()
    }
  })
})
