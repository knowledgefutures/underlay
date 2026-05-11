import type { Context, } from 'hono'

export async function check(c: Context,) {
  return c.json({ status: 'ok', timestamp: new Date().toISOString(), },)
}
