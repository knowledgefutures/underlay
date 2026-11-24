/** What an asset is served as: its download name (v3/files.ts) and media type (files/files.ts). */
import { describe, expect, it } from 'vitest'

import { safeMediaType } from '../src/files/files.js'
import { attachment, downloadName } from '../src/v3/files.js'

describe('serving an asset', () => {
  it('saves it under a name that does not run when opened, or its hash', () => {
    expect(downloadName('report.pdf')).toBe('report.pdf')
    for (const n of ['invoice.pdf.exe', 'run.BAT', 'setup.msi.', 'a\u202etxt.exe', '../x', ''])
      expect(downloadName(n)).toBeNull()
    expect(attachment('ab', 'invoice.pdf.exe')).toBe('attachment; filename="ab"')
    expect(attachment('ab', 'r\u00e9sum\u00e9.pdf')).toBe(
      `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
    )
  })

  it('serves a type a browser renders, or one a header cannot carry, as bytes', () => {
    expect(safeMediaType('Image/PNG')).toBe('image/png')
    expect(safeMediaType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8')
    for (const t of [
      'text/html',
      'image/svg+xml',
      'application/atom+xml',
      'text/javascript',
      'text/plain; name=\u540d',
      'nope',
      null,
    ])
      expect(safeMediaType(t)).toBe('application/octet-stream')
  })
})
