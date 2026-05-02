import type { FastifyInstance } from "fastify";
import { getMirrorConfig } from "../../lib/mirror-config.js";
import {
  runMirrorSync,
  testUpstreamConnection,
  getMirrorStatus,
  getSyncHistory,
  syncEvents,
  stopSync,
  isSyncRunning,
  getActiveRunId,
  getActiveRunLogs,
  type SyncProgressEvent,
} from "../../lib/mirror-sync.js";

export async function adminRoutes(app: FastifyInstance) {
  // All admin routes require mirror mode to be enabled
  app.addHook("onRequest", async (_request, reply) => {
    const config = getMirrorConfig();
    if (!config.enabled) {
      return reply.status(404).send({ error: "Not found", statusCode: 404 });
    }
  });

  // Get mirror status
  app.get("/admin/mirror/status", async () => {
    const status = await getMirrorStatus();
    return status;
  });

  // Test upstream connection
  app.post("/admin/mirror/test", async () => {
    const config = getMirrorConfig();
    const result = await testUpstreamConnection(config.upstream);
    return result;
  });

  // Trigger a sync manually (fire-and-forget, client uses SSE for progress)
  app.post("/admin/mirror/sync", async () => {
    if (isSyncRunning()) {
      return { started: false, error: "A sync is already running" };
    }
    // Start sync in background — don't await
    runMirrorSync("manual").catch((err) => {
      console.error("[mirror-sync] Unhandled sync error:", err);
    });
    return { started: true };
  });

  // Stop a running sync
  app.post("/admin/mirror/sync/stop", async () => {
    const stopped = stopSync();
    return { stopped };
  });

  // SSE endpoint for live sync progress (replays buffered logs on connect)
  app.get("/admin/mirror/sync/progress", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Replay buffered logs so reconnects/refreshes don't lose history
    const buffered = getActiveRunLogs();
    if (buffered.length > 0) {
      for (const msg of buffered) {
        const replayEvent: SyncProgressEvent = { type: "collection", message: msg, progress: { collectionsTotal: 0, collectionsProcessed: 0, versionsPulled: 0, filesDownloaded: 0, filesSkipped: 0, errors: 0 } };
        reply.raw.write(`data: ${JSON.stringify(replayEvent)}\n\n`);
      }
    }

    // If no sync is running, close immediately
    if (!isSyncRunning()) {
      reply.raw.end();
      return;
    }

    function onProgress(event: SyncProgressEvent) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "done") {
        setTimeout(() => reply.raw.end(), 100);
      }
    }

    syncEvents.on("progress", onProgress);

    request.raw.on("close", () => {
      syncEvents.off("progress", onProgress);
    });
  });

  // Get current sync running state (for page refresh reconnection)
  app.get("/admin/mirror/sync/active", async () => {
    return {
      running: isSyncRunning(),
      runId: getActiveRunId(),
      logs: getActiveRunLogs(),
    };
  });

  // Sync history
  app.get("/admin/mirror/history", async (request) => {
    const limit = Math.min(
      Number((request.query as any)?.limit) || 20,
      100,
    );
    return getSyncHistory(limit);
  });
}
