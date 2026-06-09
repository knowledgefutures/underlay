import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function serverOnly(): import('vite').Plugin {
  return {
    name: 'server-only',
    resolveId(source, importer) {
      if (source.endsWith('.server') || source.includes('.server.')) {
        if (importer && !importer.includes('.server.') && !importer.includes('entry-server')) {
          if (importer.endsWith('server.ts')) {
            return null
          }
          this.error(`Cannot import server-only module "${source}" from client code "${importer}"`)
        }
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [
    react({ babel: { plugins: [['babel-plugin-react-compiler']] } }),
    tailwindcss(),
    serverOnly(),
  ],
  resolve: {
    alias: { '~': resolve(__dirname, 'src') },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        client: resolve(__dirname, 'index.html'),
      },
    },
  },
  server: {
    hmr: { port: 24688 },
  },
  ssr: {
    external: ['react', 'react-dom', 'react-router', 'postgres', 'better-sqlite3', 'bcrypt'],
  },
})
