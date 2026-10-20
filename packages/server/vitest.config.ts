import { defineConfig } from 'vitest/config'

// The suite runs once a record layout: new collections on today's (leaf bodies), then
// on layout F (packs per collection). Both are live while collections convert.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'today',
          include: ['test/**/*.test.ts'],
          env: { UNDERLAY_TEST_LAYOUT: 'today' },
        },
      },
      {
        extends: true,
        test: { name: 'f', include: ['test/**/*.test.ts'], env: { UNDERLAY_TEST_LAYOUT: 'f' } },
      },
    ],
  },
})
