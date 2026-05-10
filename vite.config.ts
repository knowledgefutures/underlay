import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

function serverOnly(): import('vite').Plugin {
  return {
    name: 'server-only',
    resolveId(source, importer) {
      if (source.endsWith('.server') || source.includes('.server.')) {
        if (importer && !importer.includes('.server.') && !importer.includes('entry-server')) {
          if (importer.endsWith('server.ts') || importer.includes('loaders.server')) {
            return null
          }
          this.error(
            `Cannot import server-only module "${source}" from client code "${importer}"`,
          )
        }
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serverOnly()],
  resolve: {
    alias: { '~': resolve(__dirname, 'src') },
  },
  build: {
    rollupOptions: {
      input: {
        client: resolve(__dirname, 'index.html'),
      },
    },
  },
  ssr: {
    external: ['react', 'react-dom', 'react-router', 'postgres', 'better-sqlite3', 'bcrypt'],
  },
})
