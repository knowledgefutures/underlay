/**
 * Build @underlay/protocol for the browser: one ESM bundle of src/index.ts with
 * esbuild, `platform: 'browser'`. Any import a browser can't satisfy (a `node:`
 * module, even a lazy one) fails the build. Used by the browser test and by
 * `pnpm --filter @underlay/protocol check-browser`.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** `iife` exposes the package as the global `underlay`, for running it in a VM. */
export async function browserBundle(
  format: 'esm' | 'iife' = 'esm',
): Promise<{ code: string; bytes: number; gzip: number }> {
  const out = await build({
    entryPoints: [resolve(root, 'src/index.ts')],
    bundle: true,
    platform: 'browser',
    format,
    ...(format === 'iife' ? { globalName: 'underlay' } : {}),
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'silent',
  })
  const code = out.outputFiles[0]!.text
  return { code, bytes: code.length, gzip: gzipSync(code).length }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { bytes, gzip } = await browserBundle()
  console.log(
    `browser bundle ok: ${(bytes / 1024).toFixed(0)} KB, ${(gzip / 1024).toFixed(0)} KB gzipped`,
  )
}
