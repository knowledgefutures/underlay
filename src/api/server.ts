import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";

import authPlugin from "./plugins/auth.js";
import { healthRoutes } from "./routes/health.js";
import { accountRoutes } from "./routes/accounts.js";
import { collectionsRoutes } from "./routes/collections.js";
import { versionRoutes } from "./routes/versions.js";
import { recordTypeRoutes } from "./routes/recordTypes.js";
import { fileRoutes } from "./routes/files.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
    },
    bodyLimit: 100 * 1024 * 1024, // 100 MB — version pushes and file uploads can be large
  });

  // Core plugins
  await app.register(cookie, {
    secret: process.env.SESSION_SECRET ?? "dev-secret-change-me",
  });

  await app.register(cors, {
    origin: process.env.APP_URL ?? "http://localhost:4321",
    credentials: true,
  });

  await app.register(multipart, {
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB for large files
  });

  // Allow raw binary uploads (PDFs, HTML, etc.)
  app.addContentTypeParser("application/pdf", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("text/html", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  // Auth
  await app.register(authPlugin);

  // Routes
  await app.register(healthRoutes, { prefix: "/api" });
  await app.register(accountRoutes, { prefix: "/api" });
  await app.register(collectionsRoutes, { prefix: "/api" });
  await app.register(versionRoutes, { prefix: "/api" });
  await app.register(recordTypeRoutes, { prefix: "/api" });
  await app.register(fileRoutes, { prefix: "/api" });

  return app;
}

const isMain =
  process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");

if (isMain) {
  const app = await buildApp();
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
}
