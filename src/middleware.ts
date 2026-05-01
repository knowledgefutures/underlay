import { defineMiddleware } from "astro:middleware";

/**
 * Astro middleware to handle /api/* requests that reach the Astro server
 * instead of Fastify. This can happen in production (standalone node adapter)
 * if the reverse proxy isn't configured, or during certain edge cases in dev.
 *
 * Returns a proper JSON error instead of Astro's HTML 404 page.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  if (context.url.pathname.startsWith("/api")) {
    // In dev, Vite's proxy should handle this. In production, Caddy routes /api/* to Fastify.
    // If we get here, it means the request wasn't routed correctly.
    return new Response(
      JSON.stringify({ error: "API route not found", statusCode: 404 }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return next();
});
