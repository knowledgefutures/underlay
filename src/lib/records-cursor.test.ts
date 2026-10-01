import { describe, expect, it } from 'vitest'

import { decodeRecordsAfter, encodeRecordsCursor } from './records-cursor'

describe('records cursor', () => {
  it('round-trips an (id, hash) pair', () => {
    const cursor = encodeRecordsCursor('pub-002', 'abc123')
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeRecordsAfter(cursor)).toEqual({
      kind: 'pair',
      recordId: 'pub-002',
      recordHash: 'abc123',
    })
  })

  it('round-trips ids with unusual characters', () => {
    const cursor = encodeRecordsCursor('a/b c?d=é', 'h')
    expect(decodeRecordsAfter(cursor)).toMatchObject({ recordId: 'a/b c?d=é' })
  })

  it('treats a bare record id as an id', () => {
    expect(decodeRecordsAfter('pub-002')).toEqual({ kind: 'id', recordId: 'pub-002' })
    expect(decodeRecordsAfter('has spaces/and:colons')).toEqual({
      kind: 'id',
      recordId: 'has spaces/and:colons',
    })
  })

  it('treats base64 that is not a cursor as an id', () => {
    const notCursor = Buffer.from(JSON.stringify({ added: ['x', 'y'] })).toString('base64url')
    expect(decodeRecordsAfter(notCursor)).toEqual({ kind: 'id', recordId: notCursor })
    const wrongShape = Buffer.from(JSON.stringify({ r: ['only-one'] })).toString('base64url')
    expect(decodeRecordsAfter(wrongShape).kind).toBe('id')
    const jsonNull = Buffer.from('null').toString('base64url')
    expect(decodeRecordsAfter(jsonNull).kind).toBe('id')
  })
})
