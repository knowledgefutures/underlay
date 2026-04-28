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
  // API key auth via Bearer token
  app.decorateRequest("accountId", undefined);
  app.decorateRequest("apiKeyScope", undefined);
  app.decorateRequest("apiKeyCollectionId", undefined);
  app.decorateRequest("sessionUserId", undefined);

  app.addHook("onRequest", async (request: FastifyRequest) => {
    const auth = request.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const token = auth.slice(7);
      const keys = await db.select().from(schema.apiKeys);
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
          return;
        }
      }
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
