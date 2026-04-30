import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index.js";

async function runMigrations(retries = 10, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[migrate] Running migrations (attempt ${attempt})...`);
      await migrate(db, { migrationsFolder: "./src/db/migrations" });
      console.log("[migrate] Done.");
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
}

runMigrations().catch((err) => {
  console.error("[migrate] Failed:", err);
  process.exit(1);
});
