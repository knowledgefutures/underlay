import type { FastifyInstance } from "fastify";
import { eq, and, count } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { requireAuth } from "../plugins/auth.js";
import { uploadToS3, deleteS3Objects, listS3Objects } from "../../lib/s3.js";
import { sendEmail } from "../../lib/email.js";

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
      userAgent: request.headers["user-agent"] ?? null,
      ipAddress: request.ip,
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
      userAgent: request.headers["user-agent"] ?? null,
      ipAddress: request.ip,
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
          bio: schema.accounts.bio,
          website: schema.accounts.website,
          location: schema.accounts.location,
          avatarUrl: schema.accounts.avatarUrl,
          emailVerified: schema.accounts.emailVerified,
          notificationPrefs: schema.accounts.notificationPrefs,
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
        bio: schema.accounts.bio,
        website: schema.accounts.website,
        location: schema.accounts.location,
        avatarUrl: schema.accounts.avatarUrl,
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

  // Update own profile
  app.patch(
    "/accounts/me",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { displayName, bio, website, location, notificationPrefs } = request.body as {
        displayName?: string;
        bio?: string;
        website?: string;
        location?: string;
        notificationPrefs?: Record<string, boolean>;
      };

      const updates: Record<string, any> = {};
      if (displayName !== undefined) updates.displayName = displayName;
      if (bio !== undefined) updates.bio = bio;
      if (website !== undefined) updates.website = website;
      if (location !== undefined) updates.location = location;
      if (notificationPrefs !== undefined) updates.notificationPrefs = notificationPrefs;

      if (Object.keys(updates).length > 0) {
        await db.update(schema.accounts).set(updates).where(eq(schema.accounts.id, request.accountId!));
      }

      return { ok: true };
    },
  );

  // Change email (requires current password)
  app.post(
    "/accounts/me/email",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { newEmail, password } = request.body as { newEmail: string; password: string };

      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, request.accountId!))
        .limit(1);

      if (!account?.passwordHash) {
        return reply.status(400).send({ error: "Cannot change email for this account type", statusCode: 400 });
      }

      const valid = await bcrypt.compare(password, account.passwordHash);
      if (!valid) {
        return reply.status(401).send({ error: "Invalid password", statusCode: 401 });
      }

      // Check email not taken
      const [existing] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.email, newEmail))
        .limit(1);

      if (existing && existing.id !== account.id) {
        return reply.status(409).send({ error: "Email already in use", statusCode: 409 });
      }

      await db
        .update(schema.accounts)
        .set({ email: newEmail, emailVerified: false })
        .where(eq(schema.accounts.id, request.accountId!));

      return { ok: true };
    },
  );

  // Change password
  app.post(
    "/accounts/me/password",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body as {
        currentPassword: string;
        newPassword: string;
      };

      if (newPassword.length < 8) {
        return reply.status(422).send({ error: "Password must be at least 8 characters", statusCode: 422 });
      }

      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, request.accountId!))
        .limit(1);

      if (!account?.passwordHash) {
        return reply.status(400).send({ error: "Cannot change password for this account type", statusCode: 400 });
      }

      const valid = await bcrypt.compare(currentPassword, account.passwordHash);
      if (!valid) {
        return reply.status(401).send({ error: "Current password is incorrect", statusCode: 401 });
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      await db
        .update(schema.accounts)
        .set({ passwordHash: newHash })
        .where(eq(schema.accounts.id, request.accountId!));

      return { ok: true };
    },
  );

  // Upload avatar
  app.post(
    "/accounts/me/avatar",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: "No file uploaded", statusCode: 400 });
      }

      const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
      if (!allowedTypes.includes(data.mimetype)) {
        return reply.status(422).send({ error: "Only JPEG, PNG, GIF, and WebP images are allowed", statusCode: 422 });
      }

      const buffer = await data.toBuffer();
      if (buffer.length > 5 * 1024 * 1024) {
        return reply.status(422).send({ error: "Image must be less than 5MB", statusCode: 422 });
      }

      const ext = data.mimetype.split("/")[1] === "jpeg" ? "jpg" : data.mimetype.split("/")[1];
      const key = `avatars/${request.accountId}/${Date.now()}.${ext}`;

      await uploadToS3(key, buffer, data.mimetype);

      const avatarUrl = `/api/files/avatars/${request.accountId}/${key.split("/").pop()}`;
      await db
        .update(schema.accounts)
        .set({ avatarUrl })
        .where(eq(schema.accounts.id, request.accountId!));

      return { ok: true, avatarUrl };
    },
  );

  // List sessions
  app.get(
    "/accounts/me/sessions",
    { preHandler: [requireAuth()] },
    async (request) => {
      const sessions = await db
        .select({
          id: schema.sessions.id,
          userAgent: schema.sessions.userAgent,
          ipAddress: schema.sessions.ipAddress,
          createdAt: schema.sessions.createdAt,
          expiresAt: schema.sessions.expiresAt,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, request.accountId!));

      // Get current session ID to mark it
      const currentSessionId = request.cookies?.session;
      return sessions.map((s) => ({
        ...s,
        current: s.id === currentSessionId,
      }));
    },
  );

  // Revoke a session
  app.delete(
    "/accounts/me/sessions/:sessionId",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };

      const [session] = await db
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, request.accountId!)))
        .limit(1);

      if (!session) {
        return reply.status(404).send({ error: "Session not found", statusCode: 404 });
      }

      await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
      return { ok: true };
    },
  );

  // Delete own account
  app.delete(
    "/accounts/me",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { password, confirmSlug } = request.body as { password: string; confirmSlug: string };

      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, request.accountId!))
        .limit(1);

      if (!account?.passwordHash) {
        return reply.status(400).send({ error: "Cannot delete this account type", statusCode: 400 });
      }

      if (confirmSlug !== account.slug) {
        return reply.status(422).send({ error: "Username confirmation does not match", statusCode: 422 });
      }

      const valid = await bcrypt.compare(password, account.passwordHash);
      if (!valid) {
        return reply.status(401).send({ error: "Invalid password", statusCode: 401 });
      }

      // Check for owned collections
      const [collCount] = await db
        .select({ count: count() })
        .from(schema.collections)
        .where(eq(schema.collections.accountId, account.id));

      if (collCount && collCount.count > 0) {
        return reply.status(422).send({
          error: `You still own ${collCount.count} collection(s). Transfer or delete them before deleting your account.`,
          statusCode: 422,
        });
      }

      // Clean up S3 avatars
      try {
        const avatarKeys = await listS3Objects(`avatars/${account.id}/`);
        if (avatarKeys.length > 0) {
          await deleteS3Objects(avatarKeys);
        }
      } catch {
        // Non-fatal: avatar cleanup failed
      }

      // Cascade will handle sessions, memberships, api keys
      await db.delete(schema.accounts).where(eq(schema.accounts.id, account.id));
      reply.clearCookie("session", { path: "/" });
      return { ok: true };
    },
  );

  // --- Forgot Password ---
  app.post("/accounts/forgot-password", async (request, reply) => {
    const { email } = request.body as { email: string };

    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.email, email))
      .limit(1);

    // Always return success to prevent email enumeration
    if (!account) {
      return { ok: true };
    }

    const rawToken = uuidv4();
    const tokenHash = await bcrypt.hash(rawToken, 10);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.insert(schema.passwordResetTokens).values({
      userId: account.id,
      tokenHash,
      expiresAt,
    });

    // Send email (no-op if SMTP not configured)
    const resetUrl = `${request.protocol}://${request.hostname}/reset-password?token=${rawToken}&email=${encodeURIComponent(email)}`;
    await sendEmail({
      to: email,
      subject: "Reset your Underlay password",
      text: `Click here to reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
      html: `<p>Click <a href="${resetUrl}">here</a> to reset your password.</p><p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>`,
    });

    return { ok: true };
  });

  // --- Reset Password ---
  app.post("/accounts/reset-password", async (request, reply) => {
    const { email, token, newPassword } = request.body as {
      email: string;
      token: string;
      newPassword: string;
    };

    if (newPassword.length < 8) {
      return reply.status(422).send({ error: "Password must be at least 8 characters", statusCode: 422 });
    }

    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.email, email))
      .limit(1);

    if (!account) {
      return reply.status(400).send({ error: "Invalid or expired reset link", statusCode: 400 });
    }

    // Find valid unused tokens for this user
    const tokens = await db
      .select()
      .from(schema.passwordResetTokens)
      .where(and(
        eq(schema.passwordResetTokens.userId, account.id),
      ));

    let validToken = null;
    for (const t of tokens) {
      if (t.usedAt) continue;
      if (new Date(t.expiresAt) < new Date()) continue;
      const match = await bcrypt.compare(token, t.tokenHash);
      if (match) {
        validToken = t;
        break;
      }
    }

    if (!validToken) {
      return reply.status(400).send({ error: "Invalid or expired reset link", statusCode: 400 });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.update(schema.accounts).set({ passwordHash: newHash }).where(eq(schema.accounts.id, account.id));
    await db
      .update(schema.passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(schema.passwordResetTokens.id, validToken.id));

    return { ok: true };
  });

  // Create API key
  app.post(
    "/accounts/keys",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { label, scope, collectionId, expiresIn } = request.body as {
        label: string;
        scope: "read" | "write" | "admin";
        collectionId?: string;
        expiresIn?: number; // days, optional
      };

      const rawKey = `ul_${uuidv4().replace(/-/g, "")}`;
      const keyHash = await bcrypt.hash(rawKey, 10);
      const keyPrefix = rawKey.slice(0, 12);

      const expiresAt = expiresIn
        ? new Date(Date.now() + expiresIn * 24 * 60 * 60 * 1000)
        : null;

      const [key] = await db
        .insert(schema.apiKeys)
        .values({
          accountId: request.accountId!,
          scope,
          keyHash,
          keyPrefix,
          label,
          collectionId: collectionId ?? null,
          expiresAt,
        })
        .returning();

      return reply.status(201).send({
        id: key!.id,
        key: rawKey, // shown once
        label,
        scope,
        keyPrefix,
        collectionId: collectionId ?? null,
        expiresAt,
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
          keyPrefix: schema.apiKeys.keyPrefix,
          collectionId: schema.apiKeys.collectionId,
          expiresAt: schema.apiKeys.expiresAt,
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

  // --- Org-scoped API Keys ---

  // Create API key for an org
  app.post(
    "/accounts/:slug/keys",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const { label, scope, collectionId, expiresIn } = request.body as {
        label: string;
        scope: "read" | "write" | "admin";
        collectionId?: string;
        expiresIn?: number;
      };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      // Must be owner or admin
      const [membership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!membership || membership.role === "member") {
        return reply.status(403).send({ error: "Must be an owner or admin to manage org API keys", statusCode: 403 });
      }

      const rawKey = `ul_${uuidv4().replace(/-/g, "")}`;
      const keyHash = await bcrypt.hash(rawKey, 10);
      const keyPrefix = rawKey.slice(0, 12);

      const expiresAt = expiresIn
        ? new Date(Date.now() + expiresIn * 24 * 60 * 60 * 1000)
        : null;

      const [key] = await db
        .insert(schema.apiKeys)
        .values({
          accountId: org.id,
          scope,
          keyHash,
          keyPrefix,
          label,
          collectionId: collectionId ?? null,
          expiresAt,
        })
        .returning();

      return reply.status(201).send({
        id: key!.id,
        key: rawKey,
        label,
        scope,
        keyPrefix,
        collectionId: collectionId ?? null,
        expiresAt,
      });
    },
  );

  // List org API keys
  app.get(
    "/accounts/:slug/keys",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      // Must be a member
      const [membership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!membership) return reply.status(403).send({ error: "Forbidden", statusCode: 403 });

      const keys = await db
        .select({
          id: schema.apiKeys.id,
          label: schema.apiKeys.label,
          scope: schema.apiKeys.scope,
          keyPrefix: schema.apiKeys.keyPrefix,
          collectionId: schema.apiKeys.collectionId,
          expiresAt: schema.apiKeys.expiresAt,
          createdAt: schema.apiKeys.createdAt,
          lastUsedAt: schema.apiKeys.lastUsedAt,
        })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.accountId, org.id));

      return keys;
    },
  );

  // Delete org API key
  app.delete(
    "/accounts/:slug/keys/:id",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      const [membership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!membership || membership.role === "member") {
        return reply.status(403).send({ error: "Must be an owner or admin to manage org API keys", statusCode: 403 });
      }

      const [key] = await db
        .select()
        .from(schema.apiKeys)
        .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.accountId, org.id)))
        .limit(1);

      if (!key) return reply.status(404).send({ error: "Key not found", statusCode: 404 });

      await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, id));
      return { ok: true };
    },
  );

  // --- Org Management ---

  // Create organization
  app.post(
    "/accounts/orgs",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug, displayName } = request.body as {
        slug: string;
        displayName: string;
      };

      if (RESERVED_SLUGS.has(slug.toLowerCase())) {
        return reply.status(422).send({ error: "That name is reserved", statusCode: 422 });
      }

      if (!/^[a-z0-9][a-z0-9\-]*[a-z0-9]$/.test(slug) || slug.length < 2) {
        return reply
          .status(422)
          .send({ error: "Slug must be lowercase alphanumeric with hyphens, at least 2 characters", statusCode: 422 });
      }

      const existing = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.slug, slug))
        .limit(1);

      if (existing.length > 0) {
        return reply.status(409).send({ error: "Name already taken", statusCode: 409 });
      }

      const id = uuidv4();
      await db.insert(schema.accounts).values({
        id,
        slug,
        type: "org",
        displayName,
      });

      // Add the creating user as owner
      await db.insert(schema.orgMemberships).values({
        orgId: id,
        userId: request.accountId!,
        role: "owner",
      });

      return reply.status(201).send({ id, slug, displayName, type: "org" });
    },
  );

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
      const { displayName, bio, website, location } = request.body as {
        displayName?: string;
        bio?: string;
        website?: string;
        location?: string;
      };

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

      const updates: Record<string, any> = {};
      if (displayName !== undefined) updates.displayName = displayName;
      if (bio !== undefined) updates.bio = bio;
      if (website !== undefined) updates.website = website;
      if (location !== undefined) updates.location = location;

      if (Object.keys(updates).length > 0) {
        await db.update(schema.accounts).set(updates).where(eq(schema.accounts.id, org.id));
      }

      return { ok: true };
    },
  );

  // Upload org avatar
  app.post(
    "/accounts/:slug/avatar",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      const [membership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!membership || membership.role !== "owner") {
        return reply.status(403).send({ error: "Must be an owner to update the organization avatar", statusCode: 403 });
      }

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: "No file uploaded", statusCode: 400 });
      }

      const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
      if (!allowedTypes.includes(data.mimetype)) {
        return reply.status(422).send({ error: "Only JPEG, PNG, GIF, and WebP images are allowed", statusCode: 422 });
      }

      const buffer = await data.toBuffer();
      if (buffer.length > 5 * 1024 * 1024) {
        return reply.status(422).send({ error: "Image must be less than 5MB", statusCode: 422 });
      }

      const ext = data.mimetype.split("/")[1] === "jpeg" ? "jpg" : data.mimetype.split("/")[1];
      const key = `avatars/${org.id}/${Date.now()}.${ext}`;

      await uploadToS3(key, buffer, data.mimetype);

      const avatarUrl = `/api/files/avatars/${org.id}/${key.split("/").pop()}`;
      await db.update(schema.accounts).set({ avatarUrl }).where(eq(schema.accounts.id, org.id));

      return { ok: true, avatarUrl };
    },
  );

  // --- Org Invitations ---

  // Invite user to org
  app.post(
    "/accounts/:slug/invitations",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const { email, role } = request.body as { email: string; role: "owner" | "admin" | "member" };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      const [callerMembership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!callerMembership || callerMembership.role === "member") {
        return reply.status(403).send({ error: "Must be an owner or admin to invite members", statusCode: 403 });
      }

      // Check if already a member (by email)
      const [existingUser] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.email, email))
        .limit(1);

      if (existingUser) {
        const [existingMembership] = await db
          .select()
          .from(schema.orgMemberships)
          .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, existingUser.id)))
          .limit(1);

        if (existingMembership) {
          return reply.status(409).send({ error: "User is already a member", statusCode: 409 });
        }
      }

      const token = uuidv4();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      await db.insert(schema.orgInvitations).values({
        orgId: org.id,
        email,
        role,
        invitedBy: request.accountId!,
        token,
        expiresAt,
      });

      // Send invitation email
      const inviteUrl = `${request.protocol}://${request.hostname}/invitations/accept?token=${token}`;
      await sendEmail({
        to: email,
        subject: `You've been invited to join ${org.displayName} on Underlay`,
        text: `You've been invited to join ${org.displayName} as a ${role}.\n\nAccept: ${inviteUrl}\n\nThis invitation expires in 7 days.`,
        html: `<p>You've been invited to join <strong>${org.displayName}</strong> as a ${role}.</p><p><a href="${inviteUrl}">Accept invitation</a></p><p>This invitation expires in 7 days.</p>`,
      });

      return reply.status(201).send({ ok: true });
    },
  );

  // List pending invitations for an org
  app.get(
    "/accounts/:slug/invitations",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      const [membership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!membership) return reply.status(403).send({ error: "Forbidden", statusCode: 403 });

      const invitations = await db
        .select({
          id: schema.orgInvitations.id,
          email: schema.orgInvitations.email,
          role: schema.orgInvitations.role,
          expiresAt: schema.orgInvitations.expiresAt,
          acceptedAt: schema.orgInvitations.acceptedAt,
          createdAt: schema.orgInvitations.createdAt,
        })
        .from(schema.orgInvitations)
        .where(eq(schema.orgInvitations.orgId, org.id));

      return invitations;
    },
  );

  // Cancel an invitation
  app.delete(
    "/accounts/:slug/invitations/:id",
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };

      const [org] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, "org")))
        .limit(1);

      if (!org) return reply.status(404).send({ error: "Organization not found", statusCode: 404 });

      const [membership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, request.accountId!)))
        .limit(1);

      if (!membership || membership.role === "member") {
        return reply.status(403).send({ error: "Must be an owner or admin to cancel invitations", statusCode: 403 });
      }

      await db.delete(schema.orgInvitations).where(eq(schema.orgInvitations.id, id));
      return { ok: true };
    },
  );

  // Accept an invitation (public, token-based)
  app.post("/accounts/invitations/accept", { preHandler: [requireAuth()] }, async (request, reply) => {
    const { token } = request.body as { token: string };

    const [invitation] = await db
      .select()
      .from(schema.orgInvitations)
      .where(eq(schema.orgInvitations.token, token))
      .limit(1);

    if (!invitation) {
      return reply.status(404).send({ error: "Invitation not found", statusCode: 404 });
    }

    if (invitation.acceptedAt) {
      return reply.status(409).send({ error: "Invitation already accepted", statusCode: 409 });
    }

    if (new Date(invitation.expiresAt) < new Date()) {
      return reply.status(410).send({ error: "Invitation has expired", statusCode: 410 });
    }

    // Verify the logged-in user's email matches the invitation
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, request.accountId!))
      .limit(1);

    if (!account || account.email !== invitation.email) {
      return reply.status(403).send({ error: "This invitation was sent to a different email address", statusCode: 403 });
    }

    // Add to org
    await db.insert(schema.orgMemberships).values({
      orgId: invitation.orgId,
      userId: request.accountId!,
      role: invitation.role as "owner" | "admin" | "member",
    });

    // Mark invitation as accepted
    await db
      .update(schema.orgInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(schema.orgInvitations.id, invitation.id));

    // Get org slug for redirect
    const [org] = await db
      .select({ slug: schema.accounts.slug })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, invitation.orgId))
      .limit(1);

    return { ok: true, orgSlug: org?.slug ?? "" };
  });

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
