/**
 * Two builds from one config (package.json "build"):
 *
 *   vite build          the browser bundle: dist/client (assets/ + public/ files + .vite/manifest.json)
 *   vite build --ssr    dist/server/entry-server.js, exporting renderPage
 *
 * The client build runs first: the SSR build inlines the client's asset tags
 * from its manifest (virtual:underlay/client-assets), because a Worker can't
 * read dist/ at run time. Dependencies stay external in the SSR bundle so the
 * deployment's bundler resolves them for its runtime (wrangler picks the
 * workerd builds of react-dom/server; Node picks the node ones).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const CLIENT_ENTRY = 'src/entry-client.tsx'
const ASSETS_ID = 'virtual:underlay/client-assets'

interface ManifestChunk {
  file: string
  css?: string[]
  imports?: string[]
}

/** `<link>`/`<script>` tags for the client entry, from the client build's manifest. */
function clientAssets(): Plugin {
  return {
    name: 'underlay-client-assets',
    resolveId(id) {
      return id === ASSETS_ID ? `\0${ASSETS_ID}` : null
    },
    load(id) {
      if (id !== `\0${ASSETS_ID}`) return null
      const path = resolve(__dirname, 'dist/client/.vite/manifest.json')
      if (!existsSync(path)) {
        this.error(`Missing ${path}: run the client build (vite build) before the SSR build`)
      }
      const manifest = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, ManifestChunk>
      const entry = manifest[CLIENT_ENTRY]
      if (!entry) this.error(`${CLIENT_ENTRY} is not in the client manifest`)

      // The entry's static imports (transitively) are preloaded; their CSS is linked.
      const css = new Set<string>(entry.css ?? [])
      const preload = new Set<string>()
      const visit = (key: string) => {
        const chunk = manifest[key]
        if (!chunk || preload.has(chunk.file)) return
        preload.add(chunk.file)
        for (const c of chunk.css ?? []) css.add(c)
        for (const i of chunk.imports ?? []) visit(i)
      }
      for (const i of entry.imports ?? []) visit(i)

      const head = [
        ...[...css].map((f) => `<link rel="stylesheet" href="/${f}" />`),
        ...[...preload].map((f) => `<link rel="modulepreload" crossorigin href="/${f}" />`),
      ].join('\n    ')
      const body = `<script type="module" crossorigin src="/${entry.file}"></script>`
      return `export const assetTags = ${JSON.stringify({ head, body })}`
    },
  }
}

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [
    react({ babel: { plugins: [['babel-plugin-react-compiler']] } }),
    tailwindcss(),
    clientAssets(),
  ],
  resolve: {
    alias: { '~': resolve(__dirname, 'src') },
  },
  build: isSsrBuild
    ? {
        target: 'es2022',
        outDir: 'dist/server',
        emptyOutDir: true,
        copyPublicDir: false,
        rollupOptions: {
          input: resolve(__dirname, 'src/entry-server.tsx'),
          // One file: route components are lazy in the client but need no
          // splitting on the server, and a single module is simplest to bundle
          // into a Worker.
          output: { entryFileNames: 'entry-server.js', inlineDynamicImports: true },
        },
      }
    : {
        target: 'es2022',
        outDir: 'dist/client',
        emptyOutDir: true,
        manifest: true,
        rollupOptions: {
          input: resolve(__dirname, CLIENT_ENTRY),
        },
      },
}))
