import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { requireAuth } from "../plugins/auth.js";

const RESERVED_SLUGS = new Set([
  "explore", "docs", "connect", "blog", "dashboard", "settings",
  "api", "login", "signup", "admin", "about", "help", "support",
  "search", "new", "create", "edit", "delete", "404", "500",
]);

export async function accountRoutes(app: FastifyInstance) {
  // Signup
  app.post("/accounts/signup", async (request, reply) => {
    const { email, password, username, displayName } = request.body as {
      email: string;
      password: string;
      username: string;
      displayName: string;
    };

    if (RESERVED_SLUGS.has(username.toLowerCase())) {
      return reply.status(422).send({ error: "That username is reserved", statusCode: 422 });
    }

    const existing = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.slug, username))
      .limit(1);

    if (existing.length > 0) {
      return reply.status(409).send({ error: "Username already taken", statusCode: 409 });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = uuidv4();

    await db.insert(schema.accounts).values({
      id,
      slug: username,
      type: "user",
      displayName,
      email,
      passwordHash,
    });

    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await db.insert(schema.sessions).values({
      id: sessionId,
      userId: id,
      expiresAt,
    });

    reply.setCookie("session", sessionId, {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      expires: expiresAt,
    });

    return reply.status(201).send({ id, slug: username, displayName });
  });

  // Login
  app.post("/accounts/login", async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };

    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.email, email))
      .limit(1);

    if (!account?.passwordHash) {
      return reply.status(401).send({ error: "Invalid credentials", statusCode: 401 });
    }

    const valid = await bcrypt.compare(password, account.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: "Invalid credentials", statusCode: 401 });
    }

    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.insert(schema.sessions).values({
      id: sessionId,
      userId: account.id,
      expiresAt,
    });

    reply.setCookie("session", sessionId, {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      expires: expiresAt,
    });

    return { id: account.id, slug: account.slug, displayName: account.displayName };
  });

  // Logout
  app.post("/accounts/logout", async (request, reply) => {
    const sessionId = request.cookies?.session;
    if (sessionId) {
      await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    }
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });

  // Get current user
  app.get(
    "/accounts/me",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const [account] = await db
        .select({
          id: schema.accounts.id,
          slug: schema.accounts.slug,
          type: schema.accounts.type,
          displayName: schema.accounts.displayName,
          email: schema.accounts.email,
          createdAt: schema.accounts.createdAt,
        })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, request.accountId!))
        .limit(1);

      if (!account) {
        return reply.status(404).send({ error: "Account not found", statusCode: 404 });
      }
      return account;
    },
  );

  // Get account by slug (public)
  app.get("/accounts/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const [account] = await db
      .select({
        id: schema.accounts.id,
        slug: schema.accounts.slug,
        type: schema.accounts.type,
        displayName: schema.accounts.displayName,
        createdAt: schema.accounts.createdAt,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.slug, slug))
      .limit(1);

    if (!account) {
      return reply.status(404).send({ error: "Account not found", statusCode: 404 });
    }
    return account;
  });

  // Create API key
  app.post(
    "/accounts/keys",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { label, scope, corpusId } = request.body as {
        label: string;
        scope: "read" | "write" | "admin";
        corpusId?: string;
      };

      const rawKey = `ul_${uuidv4().replace(/-/g, "")}`;
      const keyHash = await bcrypt.hash(rawKey, 10);

      const [key] = await db
        .insert(schema.apiKeys)
        .values({
          accountId: request.accountId!,
          scope,
          keyHash,
          label,
          corpusId: corpusId ?? null,
        })
        .returning();

      return reply.status(201).send({
        id: key!.id,
        key: rawKey, // shown once
        label,
        scope,
        corpusId: corpusId ?? null,
      });
    },
  );

  // List API keys
  app.get(
    "/accounts/keys",
    { preHandler: [requireAuth()] },
    async (request) => {
      const keys = await db
        .select({
          id: schema.apiKeys.id,
          label: schema.apiKeys.label,
          scope: schema.apiKeys.scope,
          corpusId: schema.apiKeys.corpusId,
          createdAt: schema.apiKeys.createdAt,
          lastUsedAt: schema.apiKeys.lastUsedAt,
        })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.accountId, request.accountId!));
      return keys;
    },
  );

  // Delete API key
  app.delete(
    "/accounts/keys/:id",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [key] = await db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, id))
        .limit(1);

      if (!key || key.accountId !== request.accountId) {
        return reply.status(404).send({ error: "Key not found", statusCode: 404 });
      }

      await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, id));
      return { ok: true };
    },
  );
}
