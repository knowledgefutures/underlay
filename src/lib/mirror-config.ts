/**
 * Mirror mode configuration.
 *
 * When UNDERLAY_MODE=mirror, the server operates as a read-only mirror
 * that pulls collections from an upstream Underlay instance.
 */

export interface MirrorConfig {
  enabled: boolean
  upstream: string
  nodeName: string
  syncSchedule: string
  apiKey: string
}

/** The mirror config minus its credentials — safe to send to browsers. */
export type PublicMirrorConfig = Omit<MirrorConfig, 'apiKey'>

export function getPublicMirrorConfig(): PublicMirrorConfig {
  const { apiKey: _apiKey, ...config } = getMirrorConfig()
  return config
}

export function getMirrorConfig(): MirrorConfig {
  const mode = process.env.UNDERLAY_MODE ?? 'origin'
  return {
    enabled: mode === 'mirror',
    upstream: process.env.UNDERLAY_UPSTREAM ?? '',
    nodeName: process.env.UNDERLAY_NODE_NAME || 'IUA Mirror',
    syncSchedule: process.env.UNDERLAY_SYNC_SCHEDULE ?? '0 0 * * 0',
    apiKey: process.env.UNDERLAY_UPSTREAM_API_KEY ?? '',
  }
}
