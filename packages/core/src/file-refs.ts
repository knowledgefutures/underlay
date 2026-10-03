/**
 * File references in record data.
 *
 * One rule (v1 had two): a reference is any object, at any depth, whose `$file`
 * is a string `sha256:<64 lowercase hex>`. The walk doesn't descend into a
 * reference object. Returns bare hex hashes, deduplicated, in first-seen order.
 */
const FILE_REF = /^sha256:([0-9a-f]{64})$/

export function fileRefs(data: unknown): string[] {
  const out = new Set<string>()
  const walk = (v: unknown) => {
    if (v === null || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    const o = v as Record<string, unknown>
    const ref = o.$file
    if (typeof ref === 'string') {
      const m = FILE_REF.exec(ref)
      if (m) {
        out.add(m[1]!)
        return
      }
    }
    for (const k in o) walk(o[k])
  }
  walk(data)
  return [...out]
}
