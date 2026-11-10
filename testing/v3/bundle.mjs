/**
 * Bundle the bench and the command line into single files that run under plain
 * Node, for a machine with no install (the LighterAPI box):
 *
 *   node v3/bundle.mjs        # writes dist/bench.mjs and dist/cli.mjs
 *   rsync -a dist scripts box:~/underlay-v3-core/
 *   node --max-old-space-size=128 dist/bench.mjs suite gate
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(resolve(here, '../../packages/protocol/package.json'))
const { build } = require('esbuild')

let commit = 'unknown'
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here }).toString().trim()
  if (execFileSync('git', ['status', '--porcelain'], { cwd: here }).toString().trim()) commit += '+'
} catch {
  // Not a checkout: the bundle says so.
}

for (const name of ['bench', 'cli']) {
  await build({
    entryPoints: [resolve(here, `${name}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: resolve(here, `../dist/${name}.mjs`),
    define: { __BENCH_COMMIT__: JSON.stringify(commit) },
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'warning',
  })
}
console.log(`bundled at ${commit}: dist/bench.mjs, dist/cli.mjs`)
