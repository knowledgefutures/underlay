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

  // SSE endpoint for live sync progress
  app.get("/admin/mirror/sync/progress", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    function onProgress(event: SyncProgressEvent) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "done") {
        // Give client a moment to process, then close
        setTimeout(() => reply.raw.end(), 100);
      }
    }

    syncEvents.on("progress", onProgress);

    request.raw.on("close", () => {
      syncEvents.off("progress", onProgress);
    });
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
