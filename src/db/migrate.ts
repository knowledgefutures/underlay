import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";

// Advisory lock ID — arbitrary fixed integer used as a mutex across replicas
const MIGRATION_LOCK_ID = 72_616_384;

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://underlay:underlay@localhost:5432/underlay";

async function runMigrations(retries = 10, delay = 2000) {
  // Use a single dedicated connection (not a pool) so the advisory lock,
  // migration queries, and unlock all run on the same session.
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  try {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[migrate] Acquiring advisory lock (attempt ${attempt})...`);

        // pg_try_advisory_lock is session-level and non-blocking.
        // Returns true/false. Must be on the SAME connection as migrate().
        const result = await client`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_ID}) as acquired`;

        if (!result[0]?.acquired) {
          console.log("[migrate] Another process is running migrations, waiting...");
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        try {
          console.log("[migrate] Lock acquired. Running migrations...");
          await migrate(db, { migrationsFolder: "./src/db/migrations" });
          console.log("[migrate] Done.");
        } finally {
          await client`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
        }

        return; // success
      } catch (err: any) {
        const code = err?.cause?.code ?? err?.code;
        const isTransient =
          code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT";
        if (isTransient && attempt < retries) {
          console.log(`[migrate] DB not ready (${code}), retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
    }

    // If we exhausted retries waiting for the lock, exit successfully —
    // the other replica already ran migrations.
    console.log("[migrate] Lock not acquired after retries — another replica handled it.");
  } finally {
    await client.end();
  }
}

runMigrations()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[migrate] Failed:", err);
    process.exit(1);
  });
