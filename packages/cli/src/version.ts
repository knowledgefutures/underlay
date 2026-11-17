/** Set by scripts/build.mjs to the commit the bundle was built from; absent when run from source. */
declare const UNDERLAY_BUILD: string | undefined

export const VERSION = '0.3.0'
/** The version with its build: `0.3.0 (c52aea4)`. */
export const FULL_VERSION =
  typeof UNDERLAY_BUILD === 'string' ? `${VERSION} (${UNDERLAY_BUILD})` : VERSION
