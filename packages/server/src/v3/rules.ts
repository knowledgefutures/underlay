/**
 * What a v3 collection accepts that v2 did differently.
 *
 * Privacy is by collection (v3-deploy-plan.md, decision 1): a v3 collection is private or
 * public as a whole, with no private records or types. A push to a public v3 collection
 * that marks a record or a type private is refused, so nothing meant to be hidden is ever
 * published; in a private collection every record is already private, and the mark is
 * accepted and changes nothing.
 */
import { isPrivateSchema } from '../push/changes.js'

/** The refusal for a session whose schemas mark a type private, or null. */
export function privateMarkError(
  collectionPublic: boolean,
  schemas: Record<string, Record<string, unknown>> | null | undefined,
): string | null {
  if (!collectionPublic || !schemas) return null
  const marked = Object.entries(schemas)
    .filter(([, s]) => isPrivateSchema(s))
    .map(([t]) => t)
  if (marked.length === 0) return null
  return `This collection is public, and keeps no private types: ${marked.join(', ')} ${marked.length === 1 ? 'is' : 'are'} marked private. Make the collection private, or push ${marked.length === 1 ? 'it' : 'them'} to a private collection.`
}

/** The refusal for records marked private in a public collection. */
export const PRIVATE_RECORD_ERROR =
  'This collection is public, and keeps no private records. Make the collection private, or push them to a private collection.'

/** Where an asset's bytes are kept in the v3 area (docs/protocol-v3.md, Section 9). */
export const assetKey = (sha256: string) => `assets/${sha256}`
