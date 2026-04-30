/**
 * Shared utilities for Astro pages (server-side).
 */

/** Internal API base URL (Astro and Fastify are co-located in the same container) */
export const apiBase = "http://localhost:3000";

/** Format bytes into human-readable size */
export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/** Check if a session user owns or is a member of the given owner account */
export async function checkOwnership(
  sessionCookie: string | undefined,
  owner: string,
): Promise<boolean> {
  if (!sessionCookie) return false;
  try {
    const res = await fetch(`${apiBase}/api/accounts/me`, {
      headers: { Cookie: `session=${sessionCookie}` },
    });
    if (!res.ok) return false;
    const me = await res.json();
    return me.slug === owner || me.orgs?.some((o: any) => o.slug === owner);
  } catch {
    return false;
  }
}
