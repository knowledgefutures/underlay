/** Errors of a collection's record layout changing under a commit (layouts/convert.ts). */

/** The collection's layout changed while this commit wrote in the old one: push again. */
export class LayoutChangedError extends Error {
  constructor() {
    super("The collection's storage layout changed while this push was committing")
    this.name = 'LayoutChangedError'
  }
}

/**
 * The collection was just switched to layout F: commits wait a minute, until no
 * isolate still reads it in the old layout (stores note a layout for a minute).
 */
export class LayoutSwitchingError extends Error {
  constructor() {
    super("The collection's storage layout is switching; push again in a minute")
    this.name = 'LayoutSwitchingError'
  }
}
