/**
 * Cron scheduler — runs tools on a schedule.
 *
 * In production, this runs as its own container (the `cron` service in docker-compose.yml).
 * In dev, no jobs are registered — run tools manually with `npm run tool:<name>`.
 */

import cron from "node-cron";
import { execSync } from "node:child_process";

const log = (msg: string) =>
  console.log(`[cron] ${new Date().toISOString()} ${msg}`);

function run(name: string, script: string): void {
  log(`Starting: ${name}`);
  try {
    execSync(`npm run ${script}`, { stdio: "inherit" });
    log(`Completed: ${name}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log(`Failed: ${name} — ${error.message}`);
  }
}

if (process.env.NODE_ENV === "production") {
  // Daily at 3 AM UTC — backup Postgres database to S3
  cron.schedule("0 3 * * *", () => run("Backup DB", "tool:backup"), {
    timezone: "UTC",
  });

  log("Scheduler started — production mode");
} else {
  const logNotSet = () => {
    log(
      "NODE_ENV is not production — no jobs registered. Run tasks manually with: npm run tool:<name>",
    );
  };
  logNotSet();
  cron.schedule("0 0 * * *", logNotSet, { timezone: "UTC" });
}
