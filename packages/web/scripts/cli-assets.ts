/**
 * The Underlay CLI on the site, made fresh at every web build so the page never shows an
 * older CLI than it serves (both folders are gitignored):
 *
 *   public/cli/underlay.js, underlay.js.sha256    the bundled CLI, which /cli/install.sh
 *                                                 (packages/server/src/api/cli.ts) downloads
 *   public/cli/screenshot-*.svg                   the terminal UI, rendered by the CLI's own
 *                                                 code (packages/cli/scripts/site-assets.tsx)
 *   src/generated/cli-reference.json              every command, from packages/cli/src/program.ts
 *
 * Runs before `vite build`, which copies public/ into dist/client/.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(web, '..', 'cli')
const out = join(web, 'public', 'cli')

execFileSync('pnpm', ['run', 'build'], { cwd: cli, stdio: 'inherit' })
mkdirSync(out, { recursive: true })
copyFileSync(join(cli, 'dist', 'cli.js'), join(out, 'underlay.js'))
const sum = createHash('sha256')
  .update(readFileSync(join(out, 'underlay.js')))
  .digest('hex')
writeFileSync(join(out, 'underlay.js.sha256'), `${sum}  underlay.js\n`)
console.log(`cli: public/cli/underlay.js ${sum.slice(0, 12)}`)

execFileSync(
  'npx',
  ['tsx', 'scripts/site-assets.tsx', out, join(web, 'src', 'generated', 'cli-reference.json')],
  { cwd: cli, stdio: 'inherit' },
)
