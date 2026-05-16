import { createHash } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'

export const DEFAULT_NAAN = process.env.ARK_DEFAULT_NAAN ?? '12345'
const SITE_URL = 'https://underlay.org'

// Betanumeric: consonants (no 'l') + digits
export const BETANUMERIC = 'bcdfghjkmnpqrstvwxz0123456789' // 29 chars
export const BETANUMERIC_CONSONANTS = 'bcdfghjkmnpqrstvwxz' // 19 chars

const ARK_ID_LENGTH = 10

// NCDA (Noid Check Digit Algorithm): computed over betanumeric characters only.
// Multiply each character's alphabet index by its 1-based position, sum, mod 29.
export function computeNcdaCheckChar(name: string): string {
  let total = 0
  for (let i = 0; i < name.length; i++) {
    total += BETANUMERIC.indexOf(name[i]!) * (i + 1)
  }
  return BETANUMERIC[total % BETANUMERIC.length]!
}

// Converts a collection UUID to a 10-char betanumeric string.
// Uses SHA-256 of the UUID encoded in base-29; guarantees first char is a consonant
// so the primordinal shoulder parsing is always unambiguous.
export function collectionToArkId(collectionId: string): string {
  const hash = createHash('sha256').update(collectionId).digest()
  let n = BigInt('0x' + hash.slice(0, 8).toString('hex'))
  const base = BigInt(BETANUMERIC.length)
  const chars: string[] = []
  for (let i = 0; i < ARK_ID_LENGTH; i++) {
    chars.unshift(BETANUMERIC[Number(n % base)]!)
    n = n / base
  }
  // Primordinal shoulder parsing requires collection IDs start with a consonant
  if (!BETANUMERIC_CONSONANTS.includes(chars[0]!)) {
    chars[0] = BETANUMERIC_CONSONANTS[hash[8]! % BETANUMERIC_CONSONANTS.length]!
  }
  return chars.join('')
}

// Converts a 0-indexed count to a bijective base-19 consonant string.
// 0→"b", 1→"c", …, 18→"z", 19→"bb", 20→"bc", …
export function nextShoulderCounter(count: number): string {
  const base = BETANUMERIC_CONSONANTS.length
  let n = count + 1
  let result = ''
  while (n > 0) {
    n -= 1
    result = BETANUMERIC_CONSONANTS[n % base]! + result
    n = Math.floor(n / base)
  }
  return result
}

export async function getOrMintShoulder(accountId: string): Promise<string> {
  const [existing] = await db
    .select({ shoulder: schema.arkShoulders.shoulder })
    .from(schema.arkShoulders)
    .where(eq(schema.arkShoulders.accountId, accountId))
    .limit(1)
  if (existing) return existing.shoulder

  for (let attempt = 0; attempt < 10; attempt++) {
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.arkShoulders)
    const counter = nextShoulderCounter(countRow?.count ?? 0)
    const digit = Math.floor(Math.random() * 10).toString()
    const shoulder = `ul${counter}${digit}`
    try {
      await db.insert(schema.arkShoulders).values({ accountId, shoulder })
      return shoulder
    } catch (e: any) {
      // Retry on unique constraint violation (concurrent insert)
      if (e?.cause?.code !== '23505' && e?.code !== '23505') throw e
    }
  }
  throw new Error('Failed to mint ARK shoulder after 10 attempts')
}

export interface ArkComponents {
  shoulder: string
  collectionArkId: string
  version?: number
  recordType?: string
  recordId?: string
}

// Parses the portion of an ARK URL after "ark:NAAN/".
// Handles: shoulder+arkId, optional .vN version suffix, optional /recordType/recordId.
export function parseArkPath(pathAfterNaan: string): ArkComponents | null {
  const parts = pathAfterNaan.split('/')
  const firstSeg = parts[0]!

  if (!firstSeg.startsWith('ul')) return null

  // Shoulder = "ul" + consonant counter + single digit
  let i = 2
  while (i < firstSeg.length && BETANUMERIC_CONSONANTS.includes(firstSeg[i]!)) i++
  if (i >= firstSeg.length || !/^\d$/.test(firstSeg[i]!)) return null
  const shoulder = firstSeg.slice(0, i + 1)
  const remainder = firstSeg.slice(i + 1)

  // remainder = arkId + check char (with optional .vN suffix)
  const dotVIdx = remainder.lastIndexOf('.v')
  let arkIdWithCheck: string
  let version: number | undefined
  if (dotVIdx !== -1) {
    arkIdWithCheck = remainder.slice(0, dotVIdx)
    const vStr = remainder.slice(dotVIdx + 2)
    const vNum = parseInt(vStr, 10)
    if (isNaN(vNum) || vNum < 1) return null
    version = vNum
  } else {
    arkIdWithCheck = remainder
  }

  if (arkIdWithCheck.length < 2) return null
  const collectionArkId = arkIdWithCheck.slice(0, -1)
  const checkChar = arkIdWithCheck.slice(-1)
  if (computeNcdaCheckChar(collectionArkId) !== checkChar) return null

  const result: ArkComponents = { shoulder, collectionArkId }
  if (version !== undefined) result.version = version
  if (parts.length >= 3) {
    result.recordType = decodeURIComponent(parts[1]!)
    result.recordId = parts.slice(2).map(decodeURIComponent).join('/')
  }
  return result
}

export function buildArkUrl(
  naan: string,
  shoulder: string,
  collectionArkId: string,
  version?: number,
  recordType?: string,
  recordId?: string,
): string {
  const check = computeNcdaCheckChar(collectionArkId)
  let name = shoulder + collectionArkId + check
  if (version !== undefined) name += `.v${version}`
  if (recordType && recordId)
    name += `/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}`
  return `${SITE_URL}/ark:${naan}/${name}`
}

// Formats a date as YYYYMMDD for ERC responses.
export function formatErcDate(date: Date | string): string {
  const d = new Date(date)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

export interface ErcMetadata {
  type: 'collection' | 'version' | 'record'
  who: string
  what: string
  when: string
  where: string
  naan: string
}

export function buildErc(meta: ErcMetadata): string {
  return [
    'erc:',
    `who: ${meta.who}`,
    `what: ${meta.what}`,
    `when: ${meta.when}`,
    `where: ${meta.where}`,
    '',
    'erc-support:',
    'who: Underlay',
    'what: Underlay ARK Service',
    'when: 20260504',
    `where: ${SITE_URL}/ark:${meta.naan}/`,
  ].join('\n')
}
