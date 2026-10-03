/**
 * Protocol constants for Underlay format 2.
 *
 * Everything here is protocol: a second implementation must use the same values
 * or it will build different trees, accept different records, and compute
 * different version hashes. None of them may change without a new format
 * number. See docs/protocol-v2.md.
 *
 * Status: PROVISIONAL until the tree-parameter experiments are done and the
 * values are frozen (edge-redesign-build.md, "Decisions made while building").
 */

/** The `underlay` field of every version root. */
export const FORMAT_VERSION = 2

/** Prefix of a format-2 version hash string: `ulv2:<64 hex>`. */
export const VERSION_HASH_PREFIX = 'ulv2:'

// --- Tree shape -------------------------------------------------------------

/** A leaf ends after a key whose boundary hash has at least this many trailing zero bits (mean 1,024 entries). */
export const LEAF_BOUNDARY_BITS = 10
/** Forced leaf split: a leaf never holds more entries than this. */
export const LEAF_MAX_ENTRIES = 8_192
/** Level i ≥ 1 needs LEAF_BOUNDARY_BITS + i × this many trailing zero bits (mean fanout 64). */
export const INTERIOR_BOUNDARY_BITS_STEP = 6
/** Forced interior split: an interior node never holds more children than this. */
export const INTERIOR_MAX_CHILDREN = 1_024

// --- Input rules ------------------------------------------------------------

/** Largest integer literal magnitude accepted (2^53 − 1). */
export const MAX_SAFE_INTEGER_LITERAL = '9007199254740991'
/** Maximum nesting depth of a record's JSON (the envelope object is depth 1). */
export const MAX_JSON_DEPTH = 64
/** Maximum canonical record size in bytes: `{"id":…,"type":…,"data":…}` as UTF-8. */
export const MAX_RECORD_BYTES = 8 * 1024 * 1024
/** Maximum record id length in UTF-8 bytes. Bounds leaf node size. */
export const MAX_ID_BYTES = 1_024
/** Maximum type slug length in UTF-8 bytes. */
export const MAX_TYPE_BYTES = 128
/** Maximum canonical schema size in bytes. */
export const MAX_SCHEMA_BYTES = 256 * 1024
