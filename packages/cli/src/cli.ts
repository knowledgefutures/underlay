/** underlay: the Underlay CLI. The commands are in program.ts; plain `underlay` in a terminal opens the UI. */
import { CliError } from './core/env.js'
import { checkForUpdate } from './core/update.js'
import { env, openUi, program } from './program.js'

async function main() {
  if (process.argv.length <= 2 && process.stdin.isTTY && process.stdout.isTTY) return openUi()
  // A newer CLI, said once on stderr after the command, and only to a person at a terminal
  // (never to scripts, agents or CI). The check asks at most once a day.
  const notice = process.stderr.isTTY && process.argv[2] !== 'update' ? checkForUpdate(env) : null
  await program.parseAsync(process.argv)
  if (!notice) return
  const available = await Promise.race([
    notice,
    new Promise<null>((r) => setTimeout(() => r(null), 1500).unref()),
  ])
  if (available) console.error(`\nA newer Underlay CLI is out: run \`underlay update\``)
}

main().catch((err: unknown) => {
  if (err instanceof CliError) {
    console.error(`underlay: ${err.message}`)
    process.exit(1)
  }
  console.error(err)
  process.exit(1)
})
