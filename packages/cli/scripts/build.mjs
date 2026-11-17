/**
 * Bundle the CLI into one file, dist/cli.js, run by Node. The commit it was built from goes
 * into `underlay --version`, so two builds of one version can be told apart.
 */
import { execFileSync } from 'node:child_process'

import { build } from 'esbuild'

let commit = 'unknown'
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim()
} catch {
  // Not in a git checkout.
}

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/cli.js',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"production"',
    UNDERLAY_BUILD: JSON.stringify(commit),
  },
  // unzipper's optional S3 support; Ink's devtools, loaded only with DEV=true.
  external: ['@aws-sdk/client-s3'],
  alias: { 'react-devtools-core': './src/tui/no-devtools.ts' },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
})
console.log(`dist/cli.js (${commit})`)
