/**
 * Mirror mode configuration.
 *
 * When UNDERLAY_MODE=mirror, the server operates as a read-only mirror
 * that pulls collections from an upstream Underlay instance.
 */

export interface MirrorConfig {
  enabled: boolean;
  upstream: string;
  nodeName: string;
  syncSchedule: string;
}

export function getMirrorConfig(): MirrorConfig {
  const mode = process.env.UNDERLAY_MODE ?? "origin";
  return {
    enabled: mode === "mirror",
    upstream: process.env.UNDERLAY_UPSTREAM ?? "",
    nodeName: process.env.UNDERLAY_NODE_NAME ?? "Mirror",
    syncSchedule: process.env.UNDERLAY_SYNC_SCHEDULE ?? "0 0 * * 0",
  };
}
