import { bodyLimit } from 'hono/body-limit'

const MB = 1024 * 1024

function envBytes(name: string, fallback: number): number {
  return parseInt(process.env[name] ?? '', 10) || fallback
}

// Largest legitimate request bodies, by route. Handlers buffer bodies in memory
// (c.req.text(), parseBody, arrayBuffer), so these bound per-request heap use.
export const MAX_FILE_UPLOAD_BYTES = envBytes('MAX_FILE_UPLOAD_BYTES', 100 * MB)

// Multipart framing adds a little to the file itself.
const MULTIPART_OVERHEAD = MB

export const BODY_LIMITS = {
  // PUT /files/:hash — the file cap plus multipart framing.
  fileUpload: MAX_FILE_UPLOAD_BYTES + MULTIPART_OVERHEAD,
  // Avatar uploads are capped at 5 MB by the handler.
  avatar: 5 * MB + MULTIPART_OVERHEAD,
  // Inline manifest: up to 500k entries at ~120 bytes each is ~58 MB.
  negotiate: 64 * MB,
  // One manifest chunk: up to 50k entries at ~120 bytes each is ~6 MB.
  manifestChunk: 16 * MB,
  // Records batch: up to 10k NDJSON records (the CLI sends 5,000 per request).
  // Record size is schema-defined, so this is the one worth tuning per deployment.
  recordsBatch: envBytes('MAX_RECORDS_BATCH_BYTES', 128 * MB),
  // Commit carries at most `{ "async": true }`.
  commit: 16 * 1024,
} as const

// Global cap on /api/*: above every per-route limit, so it only catches routes
// that have no tighter one.
export const API_BODY_LIMIT = Math.max(...Object.values(BODY_LIMITS)) + MB

/** Rejects bodies over `maxSize` bytes with 413 in the API's `{ error, statusCode }` shape. */
export function limitBody(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      c.json({ error: `Request body exceeds the limit of ${maxSize} bytes`, statusCode: 413 }, 413),
  })
}
