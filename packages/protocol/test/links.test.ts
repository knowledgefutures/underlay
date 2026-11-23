/** Underlay ids, links, and asset references in record data (docs/protocol-v3.md, Sections 2.1 to 2.3). */
import { describe, expect, it } from 'vitest'

import {
  assetRefs,
  checkLinks,
  isUlId,
  links,
  makeLink,
  parseHashInput,
  parseUlId,
  ulId,
  v3,
} from '../src/index.js'
import vectors from './vectors/v3-links.json' with { type: 'json' }

const a = 'a'.repeat(64)
const b = 'b'.repeat(64)

describe('ul: ids', () => {
  it('names records, assets and versions, exactly', () => {
    expect(ulId('rec', a)).toBe(`ul:rec:${a}`)
    expect(parseUlId(`ul:asset:${b}`)).toEqual({ kind: 'asset', hash: b })
    expect(isUlId(`ul:ver:${a}`, 'ver')).toBe(true)
    expect(isUlId(`ul:ver:${a}`, 'rec')).toBe(false)
    for (const bad of [
      a,
      `ul:REC:${a}`,
      `ul:rec:${a.toUpperCase()}`,
      `ul:col:${a}`,
      `ul:rec:${a} `,
    ])
      expect(parseUlId(bad)).toBeNull()
    expect(() => ulId('rec', 'abc')).toThrow()
  })

  it('reads what a person pastes: bare hex, old prefixes, spaces and capitals', () => {
    expect(parseHashInput(` ${a.toUpperCase()} `)).toEqual({ hash: a, kind: null, form: 'hex' })
    expect(parseHashInput(`ulv3:${a}`)).toEqual({ hash: a, kind: 'ver', form: 'ulv3' })
    expect(parseHashInput(`ulv2:${a}`)).toEqual({ hash: a, kind: 'ver', form: 'ulv2' })
    expect(parseHashInput(`sha256:${a}`)).toEqual({ hash: a, kind: null, form: 'sha256' })
    expect(parseHashInput(`UL:REC:${a}`)).toEqual({ hash: a, kind: 'rec', form: 'ul' })
    expect(parseHashInput('v1.2.0')).toBeNull()
    expect(parseHashInput('latest')).toBeNull()
  })

  it('gives version ids as ul:ver: and reads every form of one', () => {
    const id = v3.versionId(new TextEncoder().encode('{}'))
    expect(id).toMatch(/^ul:ver:[0-9a-f]{64}$/)
    const hex = id.slice('ul:ver:'.length)
    expect(v3.versionHex(id)).toBe(hex)
    expect(v3.versionHex(`ulv3:${hex}`)).toBe(hex)
    expect(v3.versionHex(hex)).toBe(hex)
    expect(v3.versionHex(`ulv2:${hex}`)).toBeNull()
    expect(v3.toVersionId(`ulv3:${hex}`)).toBe(id)
    expect(v3.sameVersion(`ulv3:${hex}`, id)).toBe(true)
    expect(v3.sameVersion(null, null)).toBe(false)
  })
})

describe('links', () => {
  it('takes well-formed links at any depth, with where they were found', () => {
    const data = {
      title: 'x',
      derivedFrom: [
        { $link: `ul:rec:${a}`, collection: 'c-1', type: 'work', id: '10.1/x', rel: 'copy' },
      ],
      cover: { $link: `ul:asset:${b}` },
    }
    expect(checkLinks(data)).toBeNull()
    expect(links(data)).toEqual([
      {
        kind: 'rec',
        hash: a,
        collection: 'c-1',
        type: 'work',
        id: '10.1/x',
        path: '/derivedFrom/0',
      },
      { kind: 'asset', hash: b, path: '/cover' },
    ])
  })

  it('refuses a pasted hash or an old prefix, saying what to write', () => {
    expect(checkLinks({ x: { $link: a } })).toMatch(/at \/x is bare hex: write ul:rec:/)
    expect(checkLinks({ x: [{ $link: `ulv3:${a}` }] })).toMatch(/at \/x\/0 .*write ul:ver:/)
    expect(checkLinks({ $link: `sha256:${a}` })).toMatch(/at \/ .*write ul:asset:/)
    expect(checkLinks({ x: { $link: `UL:REC:${a}` } })).toMatch(/lowercase/)
    expect(checkLinks({ x: { $link: `ul:rec:${a}`, collection: 'a b' } })).toMatch(/collection/)
    expect(checkLinks({ x: { $link: `ul:rec:${a}`, id: 7 } })).toMatch(/"id"/)
  })

  it('reads v2 file references as asset links, and does not search inside a link', () => {
    const data = {
      pdf: { $file: `sha256:${b}`, name: 'p.pdf' },
      bad: { $file: 'sha256:short', inner: { $link: `ul:rec:${a}` } },
      l: { $link: `ul:rec:${a}`, note: { $link: 'not searched' } },
    }
    expect(checkLinks(data)).toBeNull()
    expect(links(data).map((l) => [l.path, l.kind, l.attached ?? false])).toEqual([
      ['/pdf', 'asset', true],
      ['/bad/inner', 'rec', false],
      ['/l', 'rec', false],
    ])
  })

  it('escapes keys in paths as JSON Pointer does', () => {
    expect(links({ 'a/b~c': { $link: `ul:rec:${a}` } })[0]!.path).toBe('/a~1b~0c')
  })

  it('makes a link object that checks', () => {
    const link = makeLink('rec', a, { collection: 'c-1', type: 'work', id: 'w1' })
    expect(link).toEqual({ $link: `ul:rec:${a}`, collection: 'c-1', type: 'work', id: 'w1' })
    expect(checkLinks({ l: link })).toBeNull()
    expect(() => makeLink('rec', 'x')).toThrow()
  })

  it('matches the test vectors', () => {
    for (const c of vectors.ids) {
      expect(parseUlId(c.input)).toEqual(c.id)
      expect(parseHashInput(c.input)).toEqual(c.typed)
    }
    for (const c of vectors.links) {
      expect(checkLinks(c.data)).toBe(c.problem)
      expect(links(c.data)).toEqual(c.links)
      expect(assetRefs(c.data)).toEqual(c.assets)
    }
  })
})
