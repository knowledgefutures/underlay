import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index.js";

async function runMigrations() {
  console.log("[migrate] Running migrations...");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("[migrate] Done.");
  process.exit(0);
}

runMigrations().catch((err) => {
  console.error("[migrate] Failed:", err);
  process.exit(1);
});
