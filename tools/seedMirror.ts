/**
 * Seed script for mirror mode — creates only an admin user.
 * Does not create collections, schemas, or records (those come from sync).
 *
 * Usage: npm run tool:seed-mirror
 */

import { db, schema } from "../src/db/client.server.js";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";

async function seedMirror() {
  console.log("[seed-mirror] Seeding mirror database...");

  const existing = await db.select().from(schema.accounts).limit(1);
  if (existing.length > 0) {
    console.log("[seed-mirror] Admin account already exists, skipping.");
    process.exit(0);
  }

  const password = process.env.MIRROR_ADMIN_PASSWORD ?? "admin";
  const email = process.env.MIRROR_ADMIN_EMAIL ?? "admin@mirror.underlay.org";

  const passwordHash = await bcrypt.hash(password, 10);
  const adminId = uuidv4();

  await db.insert(schema.accounts).values({
    id: adminId,
    slug: "admin",
    type: "user",
    displayName: "Mirror Admin",
    email,
    passwordHash,
  });

  console.log(`[seed-mirror] Created admin user (${email} / ${password})`);
  console.log("[seed-mirror] Done. You can now log in to /admin/mirror.");
  process.exit(0);
}

seedMirror().catch((err) => {
  console.error("[seed-mirror] Failed:", err);
  process.exit(1);
});
