import type { FastifyInstance } from "fastify";
import { getMirrorConfig } from "../../lib/mirror-config.js";
import {
  runMirrorSync,
  testUpstreamConnection,
  getMirrorStatus,
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

  // Trigger a sync manually
  app.post("/admin/mirror/sync", async () => {
    const result = await runMirrorSync();
    return result;
  });
}
