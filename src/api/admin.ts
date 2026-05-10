import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type AuthEnv } from "./auth.server.js";
import { getMirrorConfig } from "../lib/mirror-config.js";
import {
  runMirrorSync,
  testUpstreamConnection,
  getMirrorStatus,
  getSyncHistory,
  syncEvents,
  stopSync,
  cleanupStaleRuns,
  isSyncRunning,
  getActiveRunId,
  getActiveRunLogs,
  type SyncProgressEvent,
} from "../lib/mirror-sync.js";

const app = new Hono<AuthEnv>();

// All admin routes require mirror mode to be enabled
app.use("*", async (c, next) => {
  const config = getMirrorConfig();
  if (!config.enabled) {
    return c.json({ error: "Not found", statusCode: 404 }, 404);
  }
  await next();
});

// Get mirror status
app.get("/admin/mirror/status", async (c) => {
  const status = await getMirrorStatus();
  return c.json(status);
});

// Test upstream connection
app.post("/admin/mirror/test", async (c) => {
  const config = getMirrorConfig();
  const result = await testUpstreamConnection(config.upstream);
  return c.json(result);
});

// Trigger a sync manually (fire-and-forget, client uses SSE for progress)
app.post("/admin/mirror/sync", async (c) => {
  if (isSyncRunning()) {
    return c.json({ started: false, error: "A sync is already running" });
  }
  // Start sync in background — don't await
  runMirrorSync("manual").catch((err) => {
    console.error("[mirror-sync] Unhandled sync error:", err);
  });
  return c.json({ started: true });
});

// Stop a running sync (also cleans up stale DB rows from crashed processes)
app.post("/admin/mirror/sync/stop", async (c) => {
  const stopped = stopSync();
  if (!stopped) {
    // No active sync in this process — clean up stale DB rows
    const cleaned = await cleanupStaleRuns();
    return c.json({ stopped: false, cleaned });
  }
  return c.json({ stopped: true });
});

// SSE endpoint for live sync progress (replays buffered logs on connect)
app.get("/admin/mirror/sync/progress", (c) => {
  return streamSSE(c, async (stream) => {
    // Replay buffered logs so reconnects/refreshes don't lose history
    const buffered = getActiveRunLogs();
    if (buffered.length > 0) {
      for (const msg of buffered) {
        const replayEvent: SyncProgressEvent = {
          type: "collection",
          message: msg,
          progress: {
            collectionsTotal: 0,
            collectionsProcessed: 0,
            versionsPulled: 0,
            filesDownloaded: 0,
            filesSkipped: 0,
            errors: 0,
          },
        };
        await stream.writeSSE({ data: JSON.stringify(replayEvent) });
      }
    }

    // If no sync is running, close immediately
    if (!isSyncRunning()) {
      return;
    }

    const onProgress = async (event: SyncProgressEvent) => {
      await stream.writeSSE({ data: JSON.stringify(event) });
      if (event.type === "done") {
        setTimeout(() => stream.close(), 100);
      }
    };

    syncEvents.on("progress", onProgress);

    stream.onAbort(() => {
      syncEvents.off("progress", onProgress);
    });

    // Keep the stream open until aborted or done
    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });
  });
});

// Get current sync running state (for page refresh reconnection)
app.get("/admin/mirror/sync/active", async (c) => {
  return c.json({
    running: isSyncRunning(),
    runId: getActiveRunId(),
    logs: getActiveRunLogs(),
  });
});

// Sync history
app.get("/admin/mirror/history", async (c) => {
  const limit = Math.min(
    Number(c.req.query("limit")) || 20,
    100,
  );
  return c.json(await getSyncHistory(limit));
});

export { app as adminRoutes };
