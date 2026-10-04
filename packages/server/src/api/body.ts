/**
 * Request bodies read under limits: a size cap enforced while streaming, and for
 * JSON the protocol's input rules (duplicate keys, unsafe integers, lone
 * surrogates, depth), which a parsed value can no longer show.
 */
import { InputRuleError, parseStrict } from '@underlay/protocol'
import type { Context } from 'hono'

import type { AppEnv } from '../app.js'
import { jsonError } from './access.js'

export class BodyTooLarge extends Error {}

/** Read a request body as text, refusing more than `max` bytes without buffering them. */
export async function readText(c: Context<AppEnv>, max: number): Promise<string> {
  const declared = Number(c.req.header('content-length') ?? NaN)
  if (declared > max) throw new BodyTooLarge()
  const body = c.req.raw.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new BodyTooLarge()
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export type JsonBody = Record<string, unknown>

/** Parse a JSON object body under the input rules; an empty body is `{}`. */
export async function readJson(c: Context<AppEnv>, max: number): Promise<JsonBody | Response> {
  let text: string
  try {
    text = await readText(c, max)
  } catch (err) {
    if (err instanceof BodyTooLarge) return jsonError(c, 413, `Body exceeds ${max} bytes`)
    throw err
  }
  if (text.trim() === '') return {}
  try {
    const v = parseStrict(text, 128)
    if (v === null || typeof v !== 'object' || Array.isArray(v))
      return jsonError(c, 400, 'Body must be a JSON object')
    return v as JsonBody
  } catch (err) {
    if (err instanceof InputRuleError) return jsonError(c, 400, `${err.code}: ${err.message}`)
    throw err
  }
}
