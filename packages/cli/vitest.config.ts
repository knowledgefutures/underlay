import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Push and pull are tested against the server's app in-process, on v3 collections.
    env: { UNDERLAY_TEST_LAYOUT: 'v3' },
    testTimeout: 30_000,
  },
})
