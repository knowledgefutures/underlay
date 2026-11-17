/** Plain `underlay` in a terminal: the terminal UI over your home and script folders. */
import { render } from 'ink'

import { openCtx } from '../core/context.js'
import { CliError, type Env } from '../core/env.js'
import { App } from './App.js'
import { MOUSE_OFF, MOUSE_ON } from './mouse.js'
import { TITLE_RESTORE, TITLE_SAVE, titleSeq } from './title.js'

export async function runUi(env: Env): Promise<void> {
  if (!process.stdout.isTTY)
    throw new CliError('The terminal UI needs a terminal; see underlay --help for the commands')
  // The UI says nothing on stdout but its own frame: messages go to its status line.
  const ctx = openCtx(env, () => {})
  process.stdout.write(TITLE_SAVE + titleSeq())
  const restore = () => process.stdout.write(MOUSE_OFF + TITLE_RESTORE)
  process.once('exit', restore)
  const app = render(
    <App
      ctx={ctx}
      setTitle={() => process.stdout.write(titleSeq())}
      mouse={(on) => process.stdout.write(on ? MOUSE_ON : MOUSE_OFF)}
    />,
    {
      alternateScreen: true,
      exitOnCtrlC: true,
      incrementalRendering: true,
    },
  )
  // Clicks, the wheel and hover, as in Hopper; off again whenever the terminal is handed over.
  process.stdout.write(MOUSE_ON)
  try {
    await app.waitUntilExit()
  } finally {
    process.off('exit', restore)
    process.stdout.write(MOUSE_OFF)
    restore()
  }
}
