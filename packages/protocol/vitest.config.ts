import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The v3 model tests replay many random uploads: room for a slow CI runner, as the
    // server suite has.
    testTimeout: 20_000,
  },
})
