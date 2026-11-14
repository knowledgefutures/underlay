/**
 * Patterns that can backtrack exponentially. Schema `pattern`s run against every
 * record a push sends, on the server, with JavaScript's backtracking engine: one
 * like `^(a+)+$` takes minutes of CPU on a 40-character string. This refuses the
 * classic shape, a group repeated without bound that itself holds an unbounded
 * repeat (star height 2: `(a+)+`, `(a*)*`, `(\w+\s?)*`, `(?:x+)+`).
 *
 * It is a heuristic, as safe-regex is: it does not catch overlapping
 * alternatives under one repeat (`(a|a)+`), and refuses some nested repeats that
 * would in fact run fast. Bounded repeats (`{2,5}`) count as neither.
 */

/** A quantifier at `i`, if any: its length and whether it is unbounded. */
function quantifierAt(p: string, i: number): { len: number; unbounded: boolean } | null {
  const ch = p[i]
  if (ch === '*' || ch === '+') return { len: p[i + 1] === '?' ? 2 : 1, unbounded: true }
  if (ch === '?') return { len: p[i + 1] === '?' ? 2 : 1, unbounded: false }
  if (ch === '{') {
    const m = /^\{(\d+)(,(\d*))?\}\??/.exec(p.slice(i))
    if (!m) return null
    return { len: m[0].length, unbounded: m[2] !== undefined && m[3] === '' }
  }
  return null
}

/** Whether `pattern` nests an unbounded repeat inside another. */
export function hasNestedRepeat(pattern: string): boolean {
  // One frame per open group: whether anything inside it repeats without bound.
  const stack: boolean[] = []
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    let atomEnd = i + 1
    let innerUnbounded = false
    if (ch === '\\') {
      atomEnd = i + 2
    } else if (ch === '[') {
      // A class is one atom: skip to its closing bracket.
      let j = i + 1
      if (pattern[j] === '^') j++
      if (pattern[j] === ']') j++
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1
      atomEnd = j + 1
    } else if (ch === '(') {
      stack.push(false)
      i++
      continue
    } else if (ch === ')') {
      innerUnbounded = stack.pop() ?? false
    } else if (ch === '|') {
      i++
      continue
    }
    const q = quantifierAt(pattern, atomEnd)
    if (ch === ')' && q?.unbounded && innerUnbounded) return true
    // What repeats without bound inside a group makes the group's contents unbounded.
    const repeats = (q?.unbounded ?? false) || (ch === ')' && innerUnbounded)
    if (repeats && stack.length) stack[stack.length - 1] = true
    i = atomEnd + (q?.len ?? 0)
  }
  return false
}
