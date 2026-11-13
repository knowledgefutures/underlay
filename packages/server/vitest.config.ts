import { defineConfig } from 'vitest/config'

// The suite runs once a record layout: new collections on today's (leaf bodies), on
// layout F (packs per collection), and on v3. All are live while collections convert.
export default defineConfig({
  test: {
    setupFiles: ['test/setup.ts'],
    // The suite runs twice and F's jobs do more per commit: room for a slow CI runner.
    testTimeout: 20_000,
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
      // v3 (v3-deploy-plan.md, Phase 1): the same suite. What v3 does not do, or not yet,
      // is skipped with its reason (test/layouts.ts).
      {
        extends: true,
        test: { name: 'v3', include: ['test/**/*.test.ts'], env: { UNDERLAY_TEST_LAYOUT: 'v3' } },
      },
    ],
  },
})
