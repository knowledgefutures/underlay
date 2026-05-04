/**
 * Cron scheduler — runs tools on a schedule.
 *
 * In production, this runs as its own container (the `cron` service in docker-compose.yml).
 * In dev, no jobs are registered — run tools manually with `npm run tool:<name>`.
 */

import cron from "node-cron";
import { execSync } from "node:child_process";
import { getMirrorConfig } from "../src/lib/mirror-config.js";
import { runMirrorSync } from "../src/lib/mirror-sync.js";

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

  // Mirror sync — only if mirror mode is enabled
  const mirrorConfig = getMirrorConfig();
  if (mirrorConfig.enabled) {
    cron.schedule(
      mirrorConfig.syncSchedule,
      async () => {
        log("Starting: Mirror sync");
        try {
          const result = await runMirrorSync("cron");
          log(
            `Completed: Mirror sync — ${result.collections.synced} collections, ${result.versions.pulled} versions pulled`,
          );
          if (result.errors.length > 0) {
            log(`  Errors: ${result.errors.slice(0, 3).join("; ")}`);
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log(`Failed: Mirror sync — ${error.message}`);
        }
      },
      { timezone: "UTC" },
    );
    log(`Mirror sync scheduled: ${mirrorConfig.syncSchedule} (upstream: ${mirrorConfig.upstream})`);
  }

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
