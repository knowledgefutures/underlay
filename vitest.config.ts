import { resolve } from 'node:path'

import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '~': resolve(__dirname, 'src') },
  },
  test: {
    environment: 'happy-dom',
    // Agent worktrees are full checkouts inside the repo; without this, running
    // tests from the main checkout also runs every worktree's copy.
    exclude: [...configDefaults.exclude, '.claude/**', 'packages/**'],
  },
})
