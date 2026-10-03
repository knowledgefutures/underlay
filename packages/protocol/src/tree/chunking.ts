/**
 * Where nodes end.
 *
 * Boundary hash: u(k) = the first 8 bytes of sha256(utf8(k)) as a big-endian
 * unsigned 64-bit integer. Under the protocol rule a leaf ends after key k when
 * u(k) mod 2^10 == 0 (equivalently: u(k) has at least 10 trailing zero bits), and
 * a level-i node ends after a child whose last key has u mod 2^(10+6i) == 0. Each
 * also ends at a forced maximum size, or at the end of its level.
 *
 * The rule is behind an interface only so the parameter experiments can compare
 * alternatives (a size-aware chunker). The protocol has exactly one rule:
 * `protocolChunking`.
 */
import { createHash } from 'node:crypto'

import {
  INTERIOR_BOUNDARY_BITS_STEP,
  INTERIOR_MAX_CHILDREN,
  LEAF_BOUNDARY_BITS,
  LEAF_MAX_ENTRIES,
} from '../constants.js'

/** The first 8 bytes of sha256(utf8(key)). */
export function boundaryBytes(key: string): Uint8Array {
  return createHash('sha256').update(key, 'utf8').digest().subarray(0, 8)
}

/** Trailing zero bits of u(k), 0–64. */
export function trailingZeros(u: Uint8Array): number {
  let tz = 0
  for (let i = 7; i >= 0; i--) {
    const b = u[i]!
    if (b === 0) {
      tz += 8
      continue
    }
    return tz + (31 - Math.clz32(b & -b))
  }
  return tz
}

export interface Chunking {
  readonly name: string
  /**
   * Does a node at `level` end after this element? `u` is the boundary hash of the
   * element's key (level 0) or of the child's last key (level ≥ 1); `size` is the
   * number of elements in the node so far, including this one.
   */
  ends(level: number, u: Uint8Array, size: number): boolean
}

export interface FixedChunkingParams {
  leafBits: number
  stepBits: number
  leafMax: number
  interiorMax: number
}

/**
 * The fixed-probability rule with explicit parameters. The protocol uses exactly
 * one parameter set (`protocolChunking`); others exist for tests, which need
 * tiny nodes to exercise deep trees and forced splits, and for the experiments.
 */
export function fixedChunking(p: FixedChunkingParams, name = 'fixed'): Chunking {
  return {
    name,
    ends(level, u, size) {
      if (level === 0) return size >= p.leafMax || trailingZeros(u) >= p.leafBits
      // Past 64 bits nothing is a natural boundary; only forced splits remain.
      const bits = p.leafBits + p.stepBits * level
      return size >= p.interiorMax || (bits <= 64 && trailingZeros(u) >= bits)
    },
  }
}

export const protocolChunking: Chunking = fixedChunking(
  {
    leafBits: LEAF_BOUNDARY_BITS,
    stepBits: INTERIOR_BOUNDARY_BITS_STEP,
    leafMax: LEAF_MAX_ENTRIES,
    interiorMax: INTERIOR_MAX_CHILDREN,
  },
  'protocol',
)
