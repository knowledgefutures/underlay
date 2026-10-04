/** HTTP access to a registry collection (the v2 API). */
import {
  type CollectionInfo,
  type LogEntry,
  type PackObject,
  type SyncSets,
  untar,
} from '@underlay/protocol'

import { CliError, type RemoteConfig } from './local.js'

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface LogPage {
  collection: CollectionInfo | null
  head: { seq: number; entryHash: string; versionHash: string } | null
  entries: LogEntry[]
}

export class Client {
  readonly base: string

  constructor(
    readonly remote: RemoteConfig,
    readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {
    this.base = `${remote.url.replace(/\/+$/, '')}/api/collections/${remote.collection}`
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.remote.token) headers.set('authorization', `Bearer ${this.remote.token}`)
    return this.fetchImpl(`${this.base}${path}`, { ...init, headers })
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init)
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
    if (!res.ok) {
      throw new CliError(
        `${init.method ?? 'GET'} ${path}: ${res.status} ${body?.error ?? res.statusText}`,
      )
    }
    return body as T
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  postNdjson<T>(path: string, lines: string[]): Promise<T> {
    return this.json<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: lines.join('\n') + '\n',
    })
  }

  /** Log entries after `after` (every page). */
  async log(after: number): Promise<LogPage> {
    const first = await this.json<LogPage>(`/log?after=${after}`)
    const entries = [...first.entries]
    while (first.head && entries.length > 0 && entries[entries.length - 1]!.seq < first.head.seq) {
      const page = await this.json<LogPage>(`/log?after=${entries[entries.length - 1]!.seq}`)
      if (page.entries.length === 0) break
      entries.push(...page.entries)
    }
    return { ...first, entries }
  }

  /** A version's pack against a base; with `all`, falls back to public when refused. */
  async pack(
    version: string,
    base: string | null,
    sets: SyncSets,
  ): Promise<{ objects: AsyncIterable<PackObject>; sets: SyncSets }> {
    const query = new URLSearchParams({ sets })
    if (base) query.set('base', base)
    const res = await this.request(`/versions/${encodeURIComponent(version)}/pack?${query}`)
    if (res.status === 403 && sets === 'all') return this.pack(version, base, 'public')
    if (!res.ok || !res.body) throw new CliError(`Fetching ${version}: ${res.status}`)
    const body = res.body
    return {
      sets,
      objects: (async function* () {
        for await (const f of untar(body)) yield { key: f.name, bytes: f.bytes }
      })(),
    }
  }
}
