/**
 * Seed script for mirror mode — creates only an admin org.
 * Does not create collections, schemas, or records (those come from sync).
 *
 * Usage: npm run tool:seed-mirror
 */

import { db, schema } from '../src/db/client.server.js'

async function seedMirror() {
  console.log('[seed-mirror] Seeding mirror database...')

  const existing = await db.select().from(schema.organization).limit(1)
  if (existing.length > 0) {
    console.log('[seed-mirror] Admin org already exists, skipping.')
    process.exit(0)
  }

  await db.insert(schema.organization).values({
    id: crypto.randomUUID(),
    slug: 'admin',
    name: 'Admin',
  })

  console.log('[seed-mirror] Created admin org')
  console.log('[seed-mirror] Done. Log in via KF Auth.')
  process.exit(0)
}

seedMirror().catch((err) => {
  console.error('[seed-mirror] Failed:', err)
  process.exit(1)
})
