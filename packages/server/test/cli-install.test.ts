/** The CLI's install script names the deployment it is served from. */
import { afterAll, describe, expect, it } from 'vitest'

import { installScript } from '../src/api/cli.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

describe('/cli/install.sh', () => {
  it('gives the script with this deployment in it, as text', async () => {
    const h = await harness()
    const res = await h.request('/cli/install.sh')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    const text = await res.text()
    expect(text).toContain('ORIGIN="http://test"')
    expect(text).toContain('/cli/underlay.js.sha256')
    expect(installScript('https://www.underlay.org')).toContain('underlay login underlay.org')
  })
})
