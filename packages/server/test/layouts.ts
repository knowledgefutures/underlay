/**
 * The layout this test project runs on (vitest.config.ts), and how a test says it does
 * not apply to one. Every skip on v3 carries its reason, so what v3 does not do yet reads
 * from the suite (v3-deploy-plan.md, Phase 1 and Phase 3).
 */
import { describe, it } from 'vitest'

import type { CollectionLayout } from '../src/ports.js'

export const testLayout = (process.env.UNDERLAY_TEST_LAYOUT ?? 'today') as CollectionLayout
export const onV3 = testLayout === 'v3'

/** Why v3 skips a test: no private records or types (decision 1), v2's own objects, or not yet. */
export type NotOnV3 =
  | 'private records or types: a v3 collection is private or public as a whole'
  | "v2's trees, roots, or packs: v3 has none"
  | `not on v3 yet: ${string}`

/** `it`, skipped on v3 for the reason given. */
export const itNotOnV3 = (_reason: NotOnV3) => it.skipIf(onV3)
/** `describe`, skipped on v3 for the reason given. */
export const describeNotOnV3 = (_reason: NotOnV3) => describe.skipIf(onV3)
