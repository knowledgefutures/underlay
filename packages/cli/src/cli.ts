/** underlay: the Underlay CLI. The commands are in program.ts; plain `underlay` in a terminal opens the UI. */
import { CliError } from './core/env.js'
import { openUi, program } from './program.js'

async function main() {
  if (process.argv.length <= 2 && process.stdin.isTTY && process.stdout.isTTY) return openUi()
  await program.parseAsync(process.argv)
}

main().catch((err: unknown) => {
  if (err instanceof CliError) {
    console.error(`underlay: ${err.message}`)
    process.exit(1)
  }
  console.error(err)
  process.exit(1)
})
