import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import bcrypt from "bcrypt";

declare module "fastify" {
  interface FastifyRequest {
    accountId?: string;
    apiKeyScope?: "read" | "write" | "admin";
    apiKeyCollectionId?: string | null;
    sessionUserId?: string;
  }
}

async function authPlugin(app: FastifyInstance) {
  app.decorateRequest("accountId", undefined);
  app.decorateRequest("apiKeyScope", undefined);
  app.decorateRequest("apiKeyCollectionId", undefined);
  app.decorateRequest("sessionUserId", undefined);

  // Paths that never require auth (even for POST)
  const publicPaths = new Set([
    "/api/health",
    "/api/accounts/signup",
    "/api/accounts/login",
    "/api/accounts/forgot-password",
    "/api/accounts/reset-password",
    "/api/query/generate-sql",
  ]);

  const internalToken = process.env.INTERNAL_API_TOKEN ?? "internal-dev-token";

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Internal service calls from Astro SSR
    const internalHeader = request.headers["x-internal-token"];
    if (internalHeader === internalToken) {
      request.apiKeyScope = "read";
      return;
    }

    // API key auth via Bearer token
    const auth = request.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const token = auth.slice(7);
      const keys = await db.select().from(schema.apiKeys);
      let matched = false;
      for (const key of keys) {
        const match = await bcrypt.compare(token, key.keyHash);
        if (match) {
          request.accountId = key.accountId;
          request.apiKeyScope = key.scope as "read" | "write" | "admin";
          request.apiKeyCollectionId = key.collectionId;
          await db
            .update(schema.apiKeys)
            .set({ lastUsedAt: new Date() })
            .where(eq(schema.apiKeys.id, key.id));
          matched = true;
          break;
        }
      }
      if (!matched) {
        return reply.status(401).send({ error: "Invalid API key", statusCode: 401 });
      }
      return;
    }

    // Session cookie auth
    const sessionCookie = request.cookies?.session;
    if (sessionCookie) {
      try {
        const unsigned = request.unsignCookie(sessionCookie);
        const sessionId = unsigned.valid ? unsigned.value : sessionCookie;
        if (sessionId) {
          const [session] = await db
            .select()
            .from(schema.sessions)
            .where(eq(schema.sessions.id, sessionId))
            .limit(1);
          if (session && new Date(session.expiresAt) > new Date()) {
            request.sessionUserId = session.userId;
            request.accountId = session.userId;
            request.apiKeyScope = "admin";
          }
        }
      } catch {
        // Invalid or expired cookie — ignore silently
      }
    }

    // Public GETs are allowed without auth (rate-limited by IP)
    if (request.method === "GET") return;

    // All writes (POST/PATCH/PUT/DELETE) require auth, except public paths
    if (!request.accountId) {
      const path = request.url.split("?")[0] ?? "";
      if (publicPaths.has(path)) return;
      return reply.status(401).send({ error: "Authentication required", statusCode: 401 });
    }
  });
}

export function requireAuth(scope?: "read" | "write" | "admin") {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.accountId) {
      return reply.status(401).send({ error: "Authentication required", statusCode: 401 });
    }
    if (scope === "admin" && request.apiKeyScope !== "admin") {
      return reply.status(403).send({ error: "Admin access required", statusCode: 403 });
    }
    if (scope === "write" && request.apiKeyScope === "read") {
      return reply.status(403).send({ error: "Write access required", statusCode: 403 });
    }
  };
}

export default fp(authPlugin);
