/** Plain `underlay` in a terminal: the terminal UI over your home and script folders. */
import { render } from 'ink'

import { openCtx } from '../core/context.js'
import { CliError, type Env } from '../core/env.js'
import { App } from './App.js'
import { TITLE_RESTORE, TITLE_SAVE, titleSeq } from './title.js'

export async function runUi(env: Env): Promise<void> {
  if (!process.stdout.isTTY)
    throw new CliError('The terminal UI needs a terminal; see underlay --help for the commands')
  // The UI says nothing on stdout but its own frame: messages go to its status line.
  const ctx = openCtx(env, () => {})
  process.stdout.write(TITLE_SAVE + titleSeq())
  const restore = () => process.stdout.write(TITLE_RESTORE)
  process.once('exit', restore)
  const app = render(<App ctx={ctx} setTitle={() => process.stdout.write(titleSeq())} />, {
    alternateScreen: true,
    exitOnCtrlC: true,
    incrementalRendering: true,
  })
  try {
    await app.waitUntilExit()
  } finally {
    process.off('exit', restore)
    restore()
  }
}
