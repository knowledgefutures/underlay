/** Plain `underlay` in a terminal: the terminal UI over the workspace it runs in. */
import { render } from 'ink'

import { openCtx } from '../core/context.js'
import { CliError, type Env } from '../core/env.js'
import { App } from './App.js'

export async function runUi(env: Env): Promise<void> {
  if (!process.stdout.isTTY)
    throw new CliError('The terminal UI needs a terminal; see underlay --help for the commands')
  // The UI says nothing on stdout but its own frame: messages go to its status line.
  const ctx = openCtx(env, () => {})
  const app = render(<App ctx={ctx} />, {
    alternateScreen: true,
    exitOnCtrlC: true,
    incrementalRendering: true,
  })
  await app.waitUntilExit()
}
