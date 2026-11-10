/**
 * Protocol v3 constants (docs/protocol-v3.md, Section 10). Draft: they may still
 * change, and a change to any of them changes file ids.
 */

/** A record block closes after the first line that brings it to this many bytes or more. */
export const RECORD_BLOCK_BYTES = 262_144
/** Entries in every key block but a file's last. */
export const KEY_BLOCK_ENTRIES = 1_024
/** Most entries one sorted-record-file holds. */
export const MAX_FILE_ENTRIES = 1_048_576
/** The first 8 bytes of a sorted-record-file's 16-byte trailer: `UL3SRF\n\0`. */
export const TRAILER_MAGIC = new Uint8Array([0x55, 0x4c, 0x33, 0x53, 0x52, 0x46, 0x0a, 0x00])
export const TRAILER_BYTES = 16
/** Prefix of a v3 version id: `ulv3:<64 hex>`. */
export const VERSION_ID_PREFIX = 'ulv3:'
/** Decimal digits of a commit or layout number in its key. */
export const NUMBER_WIDTH = 16

export const SCHEMA_TYPE = '$schema'
export const ASSET_TYPE = '$asset'
export const META_TYPE = '$meta'
export const RESERVED_TYPES: readonly string[] = [SCHEMA_TYPE, ASSET_TYPE, META_TYPE]
/** The one id a `$meta` row may have. */
export const META_ID = 'collection'
