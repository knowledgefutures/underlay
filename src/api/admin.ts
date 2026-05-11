import type { Context } from 'hono'
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

// Get mirror status
export async function mirrorStatus(c: Context<AuthEnv>) {
  const status = await getMirrorStatus();
  return c.json(status);
}

// Test upstream connection
export async function mirrorTest(c: Context<AuthEnv>) {
  const config = getMirrorConfig();
  const result = await testUpstreamConnection(config.upstream);
  return c.json(result);
}

// Trigger a sync manually (fire-and-forget, client uses SSE for progress)
export async function mirrorSync(c: Context<AuthEnv>) {
  if (isSyncRunning()) {
    return c.json({ started: false, error: "A sync is already running" });
  }
  // Start sync in background — don't await
  runMirrorSync("manual").catch((err) => {
    console.error("[mirror-sync] Unhandled sync error:", err);
  });
  return c.json({ started: true });
}

// Stop a running sync (also cleans up stale DB rows from crashed processes)
export async function mirrorSyncStop(c: Context<AuthEnv>) {
  const stopped = stopSync();
  if (!stopped) {
    // No active sync in this process — clean up stale DB rows
    const cleaned = await cleanupStaleRuns();
    return c.json({ stopped: false, cleaned });
  }
  return c.json({ stopped: true });
}

// SSE endpoint for live sync progress (replays buffered logs on connect)
export async function mirrorSyncProgress(c: Context<AuthEnv>) {
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
}

// Get current sync running state (for page refresh reconnection)
export async function mirrorSyncActive(c: Context<AuthEnv>) {
  return c.json({
    running: isSyncRunning(),
    runId: getActiveRunId(),
    logs: getActiveRunLogs(),
  });
}

// Sync history
export async function mirrorHistory(c: Context<AuthEnv>) {
  const limit = Math.min(
    Number(c.req.query("limit")) || 20,
    100,
  );
  return c.json(await getSyncHistory(limit));
}

