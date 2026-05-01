import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index.js";
import { sql } from "drizzle-orm";

// Advisory lock ID — arbitrary fixed integer used as a mutex across replicas
const MIGRATION_LOCK_ID = 72_616_384;

async function runMigrations(retries = 10, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[migrate] Acquiring advisory lock (attempt ${attempt})...`);

      // pg_try_advisory_lock is session-level and non-blocking.
      // If another replica holds the lock, we wait and retry.
      const [lockResult] = await db.execute(
        sql`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_ID}) as acquired`,
      );

      if (!(lockResult as any)?.acquired) {
        console.log("[migrate] Another process is running migrations, waiting...");
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      try {
        console.log("[migrate] Lock acquired. Running migrations...");
        await migrate(db, { migrationsFolder: "./src/db/migrations" });
        console.log("[migrate] Done.");
      } finally {
        // Release the advisory lock
        await db.execute(sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`);
      }

      process.exit(0);
    } catch (err: any) {
      const isTransient =
        err?.cause?.code === "ENOTFOUND" ||
        err?.cause?.code === "ECONNREFUSED" ||
        err?.cause?.code === "ETIMEDOUT";
      if (isTransient && attempt < retries) {
        console.log(`[migrate] DB not ready (${err.cause.code}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }

  // If we exhausted retries waiting for the lock, exit successfully —
  // the other replica already ran migrations.
  console.log("[migrate] Lock not acquired after retries — another replica handled it.");
  process.exit(0);
}

runMigrations().catch((err) => {
  console.error("[migrate] Failed:", err);
  process.exit(1);
});
