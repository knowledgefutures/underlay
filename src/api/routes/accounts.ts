import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
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

      // Fetch org memberships
      const memberships = await db
        .select({
          orgId: schema.orgMemberships.orgId,
          role: schema.orgMemberships.role,
          slug: schema.accounts.slug,
          displayName: schema.accounts.displayName,
        })
        .from(schema.orgMemberships)
        .innerJoin(schema.accounts, eq(schema.orgMemberships.orgId, schema.accounts.id))
        .where(eq(schema.orgMemberships.userId, account.id));

      return { ...account, orgs: memberships };
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
      const { label, scope, collectionId } = request.body as {
        label: string;
        scope: "read" | "write" | "admin";
        collectionId?: string;
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
          collectionId: collectionId ?? null,
        })
        .returning();

      return reply.status(201).send({
        id: key!.id,
        key: rawKey, // shown once
        label,
        scope,
        collectionId: collectionId ?? null,
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
          collectionId: schema.apiKeys.collectionId,
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

  // --- Org Management ---

  // List org members
  app.get(
    "/accounts/:slug/members",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      // Must be a member to view
      const [membership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!membership) return reply.status(403).send({ error: "Forbidden", statusCode: 403 });

      const members = await db
        .select({
          userId: schema.orgMemberships.userId,
          role: schema.orgMemberships.role,
          slug: schema.accounts.slug,
          displayName: schema.accounts.displayName,
        })
        .from(schema.orgMemberships)
        .innerJoin(schema.accounts, eq(schema.orgMemberships.userId, schema.accounts.id))
        .where(eq(schema.orgMemberships.orgId, org.id));

      return members;
    },
  );

  // Add org member
  app.post(
    "/accounts/:slug/members",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const { username, role } = request.body as { username: string; role: "owner" | "admin" | "member" };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      // Must be owner or admin
      const [callerMembership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!callerMembership || callerMembership.role === "member") {
        return reply.status(403).send({ error: "Must be an owner or admin to add members", statusCode: 403 });
      }

      // Find user to add
      const [user] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, username), eq(schema.accounts.type, "user")))
        .limit(1);

      if (!user) return reply.status(404).send({ error: "User not found", statusCode: 404 });

      // Check not already a member
      const [existing] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, user.id)))
        .limit(1);

      if (existing) return reply.status(409).send({ error: "Already a member", statusCode: 409 });

      await db.insert(schema.orgMemberships).values({
        orgId: org.id,
        userId: user.id,
        role: role ?? "member",
      });

      return reply.status(201).send({ ok: true, username, role });
    },
  );

  // Update member role
  app.patch(
    "/accounts/:slug/members/:userId",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug, userId } = request.params as { slug: string; userId: string };
      const { role } = request.body as { role: "owner" | "admin" | "member" };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      // Must be owner
      const [callerMembership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!callerMembership || callerMembership.role !== "owner") {
        return reply.status(403).send({ error: "Must be an owner to change roles", statusCode: 403 });
      }

      await db
        .update(schema.orgMemberships)
        .set({ role })
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, userId)));

      return { ok: true };
    },
  );

  // Remove member
  app.delete(
    "/accounts/:slug/members/:userId",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug, userId } = request.params as { slug: string; userId: string };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      // Must be owner or admin (or removing yourself)
      const [callerMembership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      const isSelf = request.accountId === userId;
      if (!callerMembership || (callerMembership.role === "member" && !isSelf)) {
        return reply.status(403).send({ error: "Forbidden", statusCode: 403 });
      }

      await db
        .delete(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, userId)));

      return { ok: true };
    },
  );

  // Update org profile
  app.patch(
    "/accounts/:slug",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const { displayName } = request.body as { displayName?: string };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      // Must be owner
      const [callerMembership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!callerMembership || callerMembership.role !== "owner") {
        return reply.status(403).send({ error: "Must be an owner to update the organization", statusCode: 403 });
      }

      const updates: Partial<{ displayName: string }> = {};
      if (displayName) updates.displayName = displayName;

      if (Object.keys(updates).length > 0) {
        await db.update(schema.accounts).set(updates).where(eq(schema.accounts.id, org.id));
      }

      return { ok: true };
    },
  );

  // Delete org
  app.delete(
    "/accounts/:slug",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      // Must be owner
      const [callerMembership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!callerMembership || callerMembership.role !== "owner") {
        return reply.status(403).send({ error: "Must be an owner to delete the organization", statusCode: 403 });
      }

      // Cascade will handle memberships, collections, etc.
      await db.delete(schema.accounts).where(eq(schema.accounts.id, org.id));
      return { ok: true };
    },
  );
}
