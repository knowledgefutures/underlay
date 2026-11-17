/**
 * Put the Underlay CLI among the site's static files: `dist/client/cli/underlay.js` (the
 * bundled CLI, built here from packages/cli) and `underlay.js.sha256`, which
 * `/cli/install.sh` (packages/server/src/api/cli.ts) downloads and checks. Run by the web
 * build, so every deploy serves the CLI of the same commit.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(web, '..', 'cli')

execFileSync('pnpm', ['run', 'build'], { cwd: cli, stdio: 'inherit' })
const out = join(web, 'dist', 'client', 'cli')
mkdirSync(out, { recursive: true })
copyFileSync(join(cli, 'dist', 'cli.js'), join(out, 'underlay.js'))
const sum = createHash('sha256')
  .update(readFileSync(join(out, 'underlay.js')))
  .digest('hex')
writeFileSync(join(out, 'underlay.js.sha256'), `${sum}  underlay.js\n`)
console.log(`cli: dist/client/cli/underlay.js ${sum.slice(0, 12)}`)
