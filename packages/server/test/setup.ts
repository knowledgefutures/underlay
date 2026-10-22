/**
 * Every test file's setup. Layout F writes a manifest's head at most once a second
 * (R2's limit a key), and each maintain job waits that out: the tests wait a fortieth.
 */
import { headConfig } from '@underlay/protocol'
import { beforeEach } from 'vitest'

beforeEach(() => {
  headConfig.intervalMs = 25
})
