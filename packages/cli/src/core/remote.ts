/**
 * A remote: a server that speaks the Underlay API, signed in to with an API key from its
 * settings page (underlay.org/settings/keys). Every call is retried on a network error, a
 * 5xx or a 429, with backoff.
 */
import type { v3 } from '@underlay/protocol'

import { remoteOf, type Settings } from './config.js'
import { CliError, type Env, type Fetch } from './env.js'

type Say = (line: string) => void

/**
 * Run a send again on a network error or a 5xx or 429, with backoff: 1, 2, 4, 8, 16
 * seconds. One dropped connection among many large files used to end a whole upload.
 */
export async function withRetry<T>(
  what: string,
  send: () => Promise<T>,
  say: Say = () => {},
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 6
  for (let attempt = 1; ; attempt++) {
    try {
      return await send()
    } catch (err) {
      const retryable =
        err instanceof RemoteError
          ? err.status >= 500 || err.status === 429
          : !(err instanceof CliError)
      if (!retryable || attempt >= attempts) throw err
      const wait = (opts.baseMs ?? 1000) * 2 ** (attempt - 1)
      say(`  ${what} failed (${(err as Error).message}); trying again in ${wait / 1000}s`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

export class RemoteError extends CliError {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, any> | null,
  ) {
    super(message)
    this.name = 'RemoteError'
  }
}

export interface Me {
  id: string
  name: string
  email: string
  orgs: { organizationId: string; role: string; slug: string; name: string }[]
}

export interface RemoteCollection {
  id: string
  slug: string
  name: string
  public: boolean
  ownerSlug?: string
  description: string | null
  latestVersion: string | null
  recordCount: number | null
  totalBytes: number | null
  lastPushAt: string | null
  /** The protocol its versions are in; absent from a server older than this field. */
  protocol?: number
}

export interface CommitEntry {
  number: number
  id: string
  /** The commit's exact text, whose hash is its id. */
  commit: string
  receipt: v3.Receipt | null
}

export interface CommitPage {
  collection: { id: string; authority: string }
  head: number
  commits: CommitEntry[]
  more: boolean
}

export interface UploadStatus {
  upload_id: string
  status: 'open' | 'verifying' | 'landing' | 'committing' | 'committed' | 'failed' | 'expired'
  files_named?: number
  files_verified?: number
  present?: string[]
  result: { semver: string; hash: string; recordCount: number } | null
  error: {
    statusCode: number
    error: string
    problems?: string[]
    latest?: { number: number; id: string; semver: string } | null
  } | null
}

export type PresignedTarget =
  | { method: 'PUT'; url: string }
  | {
      method: 'MULTIPART'
      upload_id: string
      part_bytes: number
      parts: { n: number; url: string }[]
    }

export class Remote {
  readonly url: string

  constructor(
    readonly name: string,
    url: string,
    readonly key: string | null,
    readonly fetchImpl: Fetch,
    readonly say: Say = () => {},
  ) {
    this.url = url.replace(/\/+$/, '')
  }

  static open(env: Env, settings: Settings, name: string, say?: Say): Remote {
    const r = remoteOf(settings, name)
    return new Remote(r.name, r.url, env.keys.get(r.name), env.fetch, say)
  }

  get signedIn() {
    return this.key !== null
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.key) headers.set('authorization', `Bearer ${this.key}`)
    return withRetry(
      `${init.method ?? 'GET'} ${path}`,
      async () => {
        const res = await this.fetchImpl(`${this.url}${path}`, { ...init, headers })
        if (res.status >= 500 || res.status === 429) {
          const body = await res.text().catch(() => '')
          throw new RemoteError(
            `${this.name}: ${res.status} ${body.slice(0, 200)}`,
            res.status,
            null,
          )
        }
        return res
      },
      this.say,
    )
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init)
    const body = (await res.json().catch(() => null)) as Record<string, any> | null
    if (!res.ok) {
      const why = body?.error ?? res.statusText
      const hint =
        res.status === 401
          ? ` (sign in: underlay login ${this.name})`
          : res.status === 404 && !this.key
            ? ' (or sign in)'
            : ''
      if (res.status === 409 && /Commits are for v3 collections/.test(String(why)))
        throw new RemoteError(
          `${path
            .replace(/^\/api\/collections\//, '')
            .split('/')
            .slice(0, 2)
            .join(
              '/',
            )} on ${this.name} uses Underlay's older protocol (v2); the CLI works with v3 collections only`,
          409,
          body,
        )
      throw new RemoteError(`${this.name}${path}: ${res.status} ${why}${hint}`, res.status, body)
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

  me(): Promise<Me> {
    return this.json<Me>('/api/accounts/me')
  }

  orgCollections(org: string): Promise<RemoteCollection[]> {
    return this.json<RemoteCollection[]>(`/api/accounts/${encodeURIComponent(org)}/collections`)
  }

  async publicCollections(q?: string, limit = 50): Promise<RemoteCollection[]> {
    const qs = new URLSearchParams({ limit: String(limit) })
    if (q) qs.set('q', q)
    return (await this.json<{ collections: RemoteCollection[] }>(`/api/collections?${qs}`))
      .collections
  }

  collectionPath(org: string, name: string) {
    return `/api/collections/${encodeURIComponent(org)}/${encodeURIComponent(name)}`
  }

  collection(org: string, name: string) {
    return this.json<{
      id: string
      name: string
      description: string | null
      public: boolean
      latestVersion: { semver: string; hash: string } | null
    }>(this.collectionPath(org, name))
  }

  /** Every commit after `after`, page by page. */
  /**
   * Can this collection be followed by its commits? Not one on protocol v2, which a server
   * answers 409; a newer server converts those to v3.
   */
  async checkSyncable(org: string, name: string): Promise<void> {
    await this.json(`${this.collectionPath(org, name)}/commits?after=0&limit=1`)
  }

  async commitsAfter(org: string, name: string, after: number): Promise<CommitPage> {
    const base = this.collectionPath(org, name)
    const first = await this.json<CommitPage>(`${base}/commits?after=${after}`)
    const all = [...first.commits]
    let page = first
    while (page.more && all.length > 0) {
      page = await this.json<CommitPage>(`${base}/commits?after=${all.at(-1)!.number}`)
      if (page.commits.length === 0) break
      all.push(...page.commits)
    }
    return { ...first, commits: all, more: false }
  }

  async commit(org: string, name: string, n: number): Promise<CommitEntry> {
    return this.json<CommitEntry>(`${this.collectionPath(org, name)}/commits/${n}`)
  }

  async layout(org: string, name: string): Promise<v3.Layout | null> {
    return (
      await this.json<{ layout: v3.Layout | null }>(`${this.collectionPath(org, name)}/layout`)
    ).layout
  }

  /** A sorted-record-file's bytes. */
  async file(org: string, name: string, id: string): Promise<Uint8Array> {
    const res = await this.request(`${this.collectionPath(org, name)}/record-files/${id}`)
    if (!res.ok) throw new RemoteError(`Fetching file ${id}: ${res.status}`, res.status, null)
    return new Uint8Array(await res.arrayBuffer())
  }

  createCollection(
    org: string,
    body: { slug: string; id: string; name?: string; public: boolean },
  ) {
    return this.post<{ id: string }>(`/api/accounts/${encodeURIComponent(org)}/collections`, body)
  }

  // --- Uploads (packages/server/src/api/uploads.ts) ---

  openUpload(org: string, name: string, body: { message?: string | null; base?: string | null }) {
    return this.post<{ upload_id: string }>(`${this.collectionPath(org, name)}/uploads`, body)
  }

  uploadStatus(org: string, name: string, upload: string) {
    return this.json<UploadStatus>(`${this.collectionPath(org, name)}/uploads/${upload}`)
  }

  /** Send one file of an upload, by presigned URL, each PUT retried. */
  async sendFile(org: string, name: string, upload: string, id: string, bytes: Uint8Array) {
    const base = `${this.collectionPath(org, name)}/uploads/${upload}`
    const target = await this.post<PresignedTarget>(`${base}/files`, { id, size: bytes.byteLength })
    const put = (url: string, body: Uint8Array, what: string) =>
      withRetry(
        what,
        async () => {
          const res = await this.fetchImpl(url, { method: 'PUT', body: body as BodyInit })
          if (!res.ok)
            throw new RemoteError(
              `${what}: ${res.status} ${await res.text().catch(() => '')}`,
              res.status,
              null,
            )
          return res.headers.get('etag') ?? ''
        },
        this.say,
      )
    if (target.method === 'PUT') {
      await put(target.url, bytes, `Sending ${id.slice(0, 12)}`)
      return
    }
    const parts: { n: number; etag: string }[] = []
    for (const p of target.parts) {
      const from = (p.n - 1) * target.part_bytes
      const etag = await put(
        p.url,
        bytes.subarray(from, from + target.part_bytes),
        `Sending ${id.slice(0, 12)} part ${p.n}`,
      )
      parts.push({ n: p.n, etag })
    }
    await this.post(`${base}/files/${id}/complete`, { upload_id: target.upload_id, parts })
  }

  /** Commit an upload with the commit its author built; the status once settled. */
  async commitUpload(
    org: string,
    name: string,
    upload: string,
    body: { files: v3.FileRef[]; commit: string },
    progress: (s: UploadStatus) => void = () => {},
  ): Promise<UploadStatus> {
    const base = `${this.collectionPath(org, name)}/uploads/${upload}`
    const res = await this.request(`${base}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let first = (await res.json().catch(() => null)) as
      | UploadStatus
      | (Record<string, any> & { error?: string })
    if (!res.ok && typeof (first as any)?.status !== 'string') {
      // "The upload is not open" may answer a commit sent twice: the first send went through
      // and its answer was lost (a dropped connection, a 5xx after the commit was taken), and
      // `request` sent it again. The upload's own status says what became of it.
      const now = res.status === 409 ? await this.uploadStatus(org, name, upload) : null
      if (!now || ['open', 'expired'].includes(now.status))
        throw new RemoteError(
          `Committing: ${res.status} ${(first as any)?.error ?? ''}`,
          res.status,
          first as any,
        )
      first = now
    }
    let s = first as UploadStatus
    for (
      let wait = 500;
      !['committed', 'failed', 'open', 'expired'].includes(s.status);
      wait = Math.min(5000, wait * 2)
    ) {
      progress(s)
      await new Promise((r) => setTimeout(r, wait))
      s = await this.uploadStatus(org, name, upload)
    }
    return s
  }
}
