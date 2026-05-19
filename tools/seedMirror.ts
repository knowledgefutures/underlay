/**
 * Seed script for mirror mode — creates only an admin user.
 * Does not create collections, schemas, or records (those come from sync).
 *
 * Usage: npm run tool:seed-mirror
 */

import { v4 as uuidv4 } from 'uuid'

import { db, schema } from '../src/db/client.server.js'

async function seedMirror() {
  console.log('[seed-mirror] Seeding mirror database...')

  const existing = await db.select().from(schema.accounts).limit(1)
  if (existing.length > 0) {
    console.log('[seed-mirror] Admin account already exists, skipping.')
    process.exit(0)
  }

  const adminId = uuidv4()

  await db.insert(schema.accounts).values({
    id: adminId,
    slug: 'admin',
    type: 'user',
  })

  console.log('[seed-mirror] Created admin user')
  console.log('[seed-mirror] Done. Log in via KF Auth.')
  process.exit(0)
}

seedMirror().catch((err) => {
  console.error('[seed-mirror] Failed:', err)
  process.exit(1)
})
