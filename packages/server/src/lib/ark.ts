/**
 * ARK (Archival Resource Key) helpers: minting ids, check characters, parsing
 * and building ARK URLs, and ERC text. Pure, so they behave the same on Node
 * and Workers; the database side (shoulders, settings, resolution) is in
 * api/ark.ts. Ported from v1 unchanged in behaviour: existing ARKs must keep
 * resolving.
 */
import { createHash } from 'node:crypto'

// Workers only have process.env under nodejs_compat; don't crash without it.
export const DEFAULT_NAAN = globalThis.process?.env?.ARK_DEFAULT_NAAN ?? '12345'
// ARKs are persistent identifiers, so they always name the canonical site,
// whichever deployment minted or serves them.
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
  let n = BigInt('0x' + hash.subarray(0, 8).toString('hex'))
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

export interface ArkComponents {
  shoulder: string
  collectionArkId: string
  version?: string
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

  // remainder = arkId + check char (with optional .vX.Y.Z suffix)
  const dotVMatch = remainder.match(/\.v(\d+\.\d+\.\d+)$/)
  let arkIdWithCheck: string
  let version: string | undefined
  if (dotVMatch) {
    arkIdWithCheck = remainder.slice(0, dotVMatch.index!)
    version = `v${dotVMatch[1]}`
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
  semver?: string,
  recordType?: string,
  recordId?: string,
): string {
  const check = computeNcdaCheckChar(collectionArkId)
  let name = shoulder + collectionArkId + check
  if (semver !== undefined) name += `.${semver}`
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
