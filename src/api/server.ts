import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";

import authPlugin from "./plugins/auth.js";
import { healthRoutes } from "./routes/health.js";
import { accountRoutes } from "./routes/accounts.js";
import { collectionsRoutes } from "./routes/collections.js";
import { versionRoutes } from "./routes/versions.js";
import { uploadRoutes } from "./routes/uploads.js";
import { fileRoutes } from "./routes/files.js";
import { schemaRoutes } from "./routes/schemas.js";

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
    origin: true,
    credentials: true,
  });

  // Rate limiting: unauthenticated gets 60/min, authenticated gets 5000/min
  await app.register(rateLimit, {
    max: (request) => request.accountId ? 5000 : 60,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      if (request.accountId) return `acct:${request.accountId}`;
      return request.ip;
    },
    hook: "preHandler", // runs after onRequest (auth), so accountId is set
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
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
  await app.register(uploadRoutes, { prefix: "/api" });
  await app.register(fileRoutes, { prefix: "/api" });
  await app.register(schemaRoutes, { prefix: "/api" });

  return app;
}

const isMain =
  process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");

if (isMain) {
  const app = await buildApp();
  await app.listen({ port: 3000, host: "0.0.0.0" });
}
