import { useCallback, useEffect, useRef, useState } from 'react'

import BaseLayout from '~/components/BaseLayout'

interface LogEntry {
  time: string
  direction: 'req' | 'res' | 'info' | 'error'
  method?: string | undefined
  url?: string | undefined
  status?: number | undefined
  body?: string | undefined
  duration?: number | undefined
}

interface RecordRow {
  key: number
  id: string
  type: string
  data: string
  status: 'added' | 'updated' | 'existing' | 'removed'
}

interface VersionInfo {
  semver: string
  hash: string
  recordCount: number
  fileCount: number
}

let rowCounter = 0

export default function DevPage() {
  const [owner, setOwner] = useState('knowledge-futures')
  const [slug, setSlug] = useState('pubpub-archive')
  const [apiKey, setApiKey] = useState('')
  const [schemaJson, setSchemaJson] = useState('{}')
  const [records, setRecords] = useState<RecordRow[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [latestVersion, setLatestVersion] = useState<VersionInfo | null>(null)
  const [baseVersion, setBaseVersion] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [batchSize, setBatchSize] = useState(5)
  const [working, setWorking] = useState(false)
  const [stripUnknownFields, setStripUnknownFields] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const collectionBase = `/api/collections/${owner}/${slug}`

  const log = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev, entry])
    setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 50)
  }, [])

  const apiFetch = useCallback(
    async (method: string, path: string, body?: unknown): Promise<Response> => {
      const url = path.startsWith('http') ? path : path
      const headers: Record<string, string> = {}
      if (body) headers['Content-Type'] = 'application/json'
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

      const bodyStr = body ? JSON.stringify(body, null, 2) : undefined
      log({
        time: new Date().toISOString().slice(11, 23),
        direction: 'req',
        method,
        url: path,
        body: bodyStr,
      })

      const start = performance.now()
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
        credentials: 'same-origin',
      })
      const duration = Math.round(performance.now() - start)

      let resBody: string
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('json')) {
        const json = await res.json()
        resBody = JSON.stringify(json, null, 2)
      } else {
        resBody = await res.text()
      }

      log({
        time: new Date().toISOString().slice(11, 23),
        direction: res.ok ? 'res' : 'error',
        method,
        url: path,
        status: res.status,
        body: resBody,
        duration,
      })

      // Return a new Response so callers can still read the body
      return new Response(resBody, {
        status: res.status,
        headers: { 'Content-Type': ct },
      })
    },
    [apiKey, log],
  )

  const fetchLatest = useCallback(async () => {
    const res = await apiFetch('GET', `${collectionBase}/versions/latest`)
    if (res.ok) {
      const data = await res.json()
      setLatestVersion(data)
      setBaseVersion(data.semver)
    } else {
      setLatestVersion(null)
      setBaseVersion(null)
      log({
        time: new Date().toISOString().slice(11, 23),
        direction: 'info',
        body: 'No versions exist yet — base_version will be null',
      })
    }
  }, [apiFetch, collectionBase, log])

  const fetchRecords = useCallback(async () => {
    if (!latestVersion) return
    setWorking(true)
    try {
      const allRecords: RecordRow[] = []
      let cursor: string | null = null
      let hasMore = true

      while (hasMore) {
        const params = new URLSearchParams({ limit: '1000' })
        if (cursor) params.set('after', cursor)
        const res = await apiFetch(
          'GET',
          `${collectionBase}/versions/${latestVersion.semver}/records?${params}`,
        )
        if (!res.ok) break
        const data = await res.json()
        for (const rec of data.records) {
          allRecords.push({
            key: rowCounter++,
            id: rec.id,
            type: rec.type,
            data: JSON.stringify(rec.data),
            status: 'existing',
          })
        }
        hasMore = data.pagination?.hasMore ?? false
        cursor = data.pagination?.nextCursor ?? null
      }

      setRecords(allRecords)
      log({
        time: new Date().toISOString().slice(11, 23),
        direction: 'info',
        body: `Loaded ${allRecords.length} records`,
      })
    } finally {
      setWorking(false)
    }
  }, [apiFetch, collectionBase, latestVersion, log])

  const fetchSchemas = useCallback(async () => {
    const version = latestVersion?.semver
    if (!version) return
    const res = await apiFetch('GET', `${collectionBase}/schemas?version=${version}&raw=true`)
    if (res.ok) {
      const data = await res.json()
      const schemaMap: Record<string, unknown> = {}
      for (const s of data.schemas) {
        schemaMap[s.slug] = s.schema
      }
      setSchemaJson(JSON.stringify(schemaMap, null, 2))
    }
  }, [apiFetch, collectionBase, latestVersion])

  const addRecord = () => {
    const types = Object.keys(tryParse(schemaJson) || {})
    setRecords((prev) => [
      ...prev,
      {
        key: rowCounter++,
        id: `new-${Date.now()}`,
        type: types[0] || 'TypeName',
        data: '{}',
        status: 'added',
      },
    ])
  }

  const updateRecord = (key: number, field: keyof RecordRow, value: string) => {
    setRecords((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r
        const updated = { ...r, [field]: value }
        if (field !== 'status' && r.status === 'existing') updated.status = 'updated'
        return updated
      }),
    )
  }

  const toggleRemove = (key: number) => {
    setRecords((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r
        if (r.status === 'removed') return { ...r, status: 'existing' }
        if (r.status === 'existing' || r.status === 'updated') return { ...r, status: 'removed' }
        return r
      }),
    )
  }

  const deleteRow = (key: number) => {
    setRecords((prev) => prev.filter((r) => r.key !== key))
  }

  const buildChanges = () => {
    const added = records
      .filter((r) => r.status === 'added')
      .map((r) => ({ id: r.id, type: r.type, data: tryParse(r.data) }))
    const updated = records
      .filter((r) => r.status === 'updated')
      .map((r) => ({ id: r.id, type: r.type, data: tryParse(r.data) }))
    const removed = records.filter((r) => r.status === 'removed').map((r) => r.id)
    return { added, updated, removed }
  }

  const simplePush = async () => {
    setWorking(true)
    try {
      const changes = buildChanges()
      const schemas = tryParse(schemaJson)
      const hasSchemas = schemas && Object.keys(schemas).length > 0
      const payload: Record<string, unknown> = {
        base_version: baseVersion,
        message: message || 'Dev push',
        app_id: 'underlay-dev-tool',
        strip_unknown_fields: stripUnknownFields,
        changes,
      }
      if (hasSchemas) {
        payload.schemas = schemas
      } else {
        log({
          time: new Date().toISOString().slice(11, 23),
          direction: 'info',
          body: 'No schemas in payload — server will carry forward from previous version',
        })
      }
      const res = await apiFetch('POST', `${collectionBase}/versions`, payload)
      if (res.ok) {
        const data = await res.json()
        log({
          time: new Date().toISOString().slice(11, 23),
          direction: 'info',
          body: `Version ${data.version} (${data.semver}) created`,
        })
        await fetchLatest()
      }
    } finally {
      setWorking(false)
    }
  }

  const batchPush = async () => {
    setWorking(true)
    try {
      const schemas = tryParse(schemaJson)

      // Step 1: Start upload session
      const hasSchemas = schemas && Object.keys(schemas).length > 0
      const startPayload: Record<string, unknown> = {
        base_version: baseVersion,
        message: message || 'Dev batch push',
        app_id: 'underlay-dev-tool',
      }
      if (hasSchemas) {
        startPayload.schemas = schemas
      } else {
        log({
          time: new Date().toISOString().slice(11, 23),
          direction: 'info',
          body: 'No schemas in payload — server will carry forward from previous version',
        })
      }

      const startRes = await apiFetch('POST', `${collectionBase}/versions/upload`, startPayload)
      if (!startRes.ok) return
      const { sessionId } = await startRes.json()

      log({
        time: new Date().toISOString().slice(11, 23),
        direction: 'info',
        body: `Upload session started: ${sessionId}`,
      })

      // Step 2: Send batches
      const changes = buildChanges()
      const allAdded = changes.added
      const allUpdated = changes.updated
      const allRemoved = changes.removed

      // Batch the added records
      for (let i = 0; i < allAdded.length; i += batchSize) {
        const batch = allAdded.slice(i, i + batchSize)
        const batchPayload = {
          changes: { added: batch, updated: [] as unknown[], removed: [] as string[] },
        }
        // Include updated and removed only in the first batch
        if (i === 0) {
          batchPayload.changes.updated = allUpdated
          batchPayload.changes.removed = allRemoved
        }
        const batchRes = await apiFetch(
          'PUT',
          `${collectionBase}/versions/upload/${sessionId}`,
          batchPayload,
        )
        if (!batchRes.ok) return
        const batchData = await batchRes.json()
        log({
          time: new Date().toISOString().slice(11, 23),
          direction: 'info',
          body: `Batch ${Math.floor(i / batchSize) + 1}: ${batchData.totalStaged} total staged`,
        })
      }

      // If no added records, still send updated/removed
      if (allAdded.length === 0 && (allUpdated.length > 0 || allRemoved.length > 0)) {
        const batchPayload = {
          changes: { added: [] as unknown[], updated: allUpdated, removed: allRemoved },
        }
        const batchRes = await apiFetch(
          'PUT',
          `${collectionBase}/versions/upload/${sessionId}`,
          batchPayload,
        )
        if (!batchRes.ok) return
      }

      // Step 3: Finalize
      const finalizeUrl = stripUnknownFields
        ? `${collectionBase}/versions/upload/${sessionId}/finalize?strip_unknown_fields=true`
        : `${collectionBase}/versions/upload/${sessionId}/finalize`
      const finalRes = await apiFetch('POST', finalizeUrl)
      if (finalRes.ok) {
        const data = await finalRes.json()
        log({
          time: new Date().toISOString().slice(11, 23),
          direction: 'info',
          body: `Finalized: version ${data.version} (${data.semver}), ${data.recordCount} records`,
        })
        await fetchLatest()
      }
    } finally {
      setWorking(false)
    }
  }

  const negotiatePush = async () => {
    setWorking(true)
    try {
      const schemas = tryParse(schemaJson)
      const allRecords = records.filter((r) => r.status !== 'removed')

      // Build manifest with hashes (compute client-side)
      const manifest: { id: string; type: string; hash: string }[] = []
      const recordBodies: Map<string, { id: string; type: string; data: unknown }> = new Map()

      for (const r of allRecords) {
        const data = tryParse(r.data)
        const canonical = JSON.stringify({ id: r.id, type: r.type, data })
        const hashBuffer = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(canonical),
        )
        const hash = Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
        manifest.push({ id: r.id, type: r.type, hash })
        recordBodies.set(hash, { id: r.id, type: r.type, data })
      }

      // Step 1: Negotiate
      const negPayload: Record<string, unknown> = {
        base_version: baseVersion,
        schemas,
        manifest,
        files: [],
        message: message || 'Dev negotiate push',
        strip_unknown_fields: stripUnknownFields,
      }
      const negRes = await apiFetch('POST', `${collectionBase}/versions/negotiate`, negPayload)
      if (!negRes.ok) return
      const negData = await negRes.json()

      log({
        time: new Date().toISOString().slice(11, 23),
        direction: 'info',
        body: `Negotiate: ${negData.needed_records.length} needed, ${negData.already_have_records} already on server`,
      })

      // Step 2: Send only needed records as JSONL
      const lines = negData.needed_records
        .map((hash: string) => {
          const rec = recordBodies.get(hash)
          return rec ? JSON.stringify(rec) : null
        })
        .filter(Boolean)
        .join('\n')

      const commitUrl = `${collectionBase}/versions/negotiate/${negData.session_id}/commit`
      const commitHeaders: Record<string, string> = { 'Content-Type': 'application/x-ndjson' }
      if (apiKey) commitHeaders['Authorization'] = `Bearer ${apiKey}`

      log({
        time: new Date().toISOString().slice(11, 23),
        direction: 'req',
        method: 'POST',
        url: commitUrl,
        body: `${lines.split('\n').length} JSONL lines (${lines.length} bytes)`,
      })

      const start = performance.now()
      const commitRes = await fetch(commitUrl, {
        method: 'POST',
        headers: commitHeaders,
        body: lines,
        credentials: 'same-origin',
      })
      const duration = Math.round(performance.now() - start)
      const commitData = await commitRes.json()

      log({
        time: new Date().toISOString().slice(11, 23),
        direction: commitRes.ok ? 'res' : 'error',
        method: 'POST',
        url: commitUrl,
        status: commitRes.status,
        body: JSON.stringify(commitData, null, 2),
        duration,
      })

      if (commitRes.ok) {
        log({
          time: new Date().toISOString().slice(11, 23),
          direction: 'info',
          body: `Version ${commitData.version} (${commitData.semver}): ${commitData.records_transferred} transferred, ${commitData.records_deduplicated} deduplicated`,
        })
        await fetchLatest()
      }
    } finally {
      setWorking(false)
    }
  }

  const copyLogs = () => {
    const text = logs
      .map((l) => {
        const prefix =
          l.direction === 'req'
            ? '>>>'
            : l.direction === 'res'
              ? '<<<'
              : l.direction === 'error'
                ? '!!!'
                : '---'
        const meta = [l.method, l.url, l.status && `(${l.status})`, l.duration && `${l.duration}ms`]
          .filter(Boolean)
          .join(' ')
        return `[${l.time}] ${prefix} ${meta}\n${l.body ?? ''}`
      })
      .join('\n\n')
    navigator.clipboard.writeText(text)
  }

  // Counts
  const added = records.filter((r) => r.status === 'added').length
  const updated = records.filter((r) => r.status === 'updated').length
  const removed = records.filter((r) => r.status === 'removed').length
  const existing = records.filter((r) => r.status === 'existing').length

  return (
    <BaseLayout>
      <div className="mx-auto max-w-7xl px-4 py-6">
        <div className="mb-4 flex items-center gap-3">
          <h1 className="text-lg font-semibold">Dev: API Test Tool</h1>
          <span className="text-ink-muted text-xs">
            Push records, test diffs, inspect responses
          </span>
        </div>

        {/* Config bar */}
        <div className="border-rule mb-4 flex flex-wrap items-end gap-3 rounded border p-3">
          <label className="text-xs">
            <span className="text-ink-muted mb-1 block">Owner</span>
            <input
              className="border-rule w-40 rounded border px-2 py-1 font-mono text-xs"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
          </label>
          <label className="text-xs">
            <span className="text-ink-muted mb-1 block">Collection</span>
            <input
              className="border-rule w-40 rounded border px-2 py-1 font-mono text-xs"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          </label>
          <label className="text-xs">
            <span className="text-ink-muted mb-1 block">API Key (optional)</span>
            <input
              className="border-rule w-56 rounded border px-2 py-1 font-mono text-xs"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="ul_... (uses session if blank)"
            />
          </label>
          <label className="text-xs">
            <span className="text-ink-muted mb-1 block">Commit Message</span>
            <input
              className="border-rule w-56 rounded border px-2 py-1 text-xs"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Dev push"
            />
          </label>
          <button onClick={fetchLatest} className="bg-ink text-parchment rounded px-3 py-1 text-xs">
            Fetch Latest
          </button>
          {latestVersion && (
            <span className="text-ink-muted text-xs">
              {latestVersion.semver} &middot; {latestVersion.recordCount} records &middot; base:{' '}
              <input
                className="border-rule w-20 rounded border px-1 text-center font-mono text-xs"
                type="text"
                value={baseVersion ?? ''}
                onChange={(e) => setBaseVersion(e.target.value || null)}
              />
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Left column: Schema + Records */}
          <div className="lg:col-span-2">
            {/* Schema */}
            <div className="border-rule mb-4 rounded border">
              <div className="border-rule flex items-center justify-between border-b px-3 py-2">
                <span className="text-xs font-semibold">Schemas</span>
                <button
                  onClick={fetchSchemas}
                  disabled={!latestVersion}
                  className="text-link text-xs hover:underline disabled:opacity-50"
                >
                  Load from latest
                </button>
              </div>
              <textarea
                className="w-full p-3 font-mono text-xs"
                rows={6}
                value={schemaJson}
                onChange={(e) => setSchemaJson(e.target.value)}
              />
            </div>

            {/* Records */}
            <div className="border-rule rounded border">
              <div className="border-rule flex items-center justify-between border-b px-3 py-2">
                <span className="text-xs font-semibold">
                  Records
                  <span className="text-ink-muted ml-2 font-normal">
                    {existing} existing, {added} added, {updated} updated, {removed} removed
                  </span>
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      fetchSchemas()
                      fetchRecords()
                    }}
                    disabled={!latestVersion || working}
                    className="text-link text-xs hover:underline disabled:opacity-50"
                  >
                    Load from latest
                  </button>
                  <button
                    onClick={addRecord}
                    className="bg-ink text-parchment rounded px-2 py-0.5 text-xs"
                  >
                    + Add Record
                  </button>
                </div>
              </div>

              <div className="max-h-[500px] overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-parchment-dark border-rule sticky top-0 border-b">
                      <th className="w-8 p-2 text-left">St</th>
                      <th className="w-36 p-2 text-left">ID</th>
                      <th className="w-24 p-2 text-left">Type</th>
                      <th className="p-2 text-left">Data (JSON)</th>
                      <th className="w-16 p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr
                        key={r.key}
                        className={`border-rule border-t ${
                          r.status === 'added'
                            ? 'bg-green-50'
                            : r.status === 'updated'
                              ? 'bg-yellow-50'
                              : r.status === 'removed'
                                ? 'bg-red-50 line-through opacity-60'
                                : ''
                        }`}
                      >
                        <td className="p-2">
                          <span
                            className={`inline-block rounded px-1 py-0.5 text-[10px] font-medium ${
                              r.status === 'added'
                                ? 'bg-green-200 text-green-800'
                                : r.status === 'updated'
                                  ? 'bg-yellow-200 text-yellow-800'
                                  : r.status === 'removed'
                                    ? 'bg-red-200 text-red-800'
                                    : 'bg-gray-200 text-gray-600'
                            }`}
                          >
                            {r.status.slice(0, 3)}
                          </span>
                        </td>
                        <td className="p-2">
                          <input
                            className="border-rule w-full rounded border px-1 py-0.5 font-mono text-xs"
                            value={r.id}
                            onChange={(e) => updateRecord(r.key, 'id', e.target.value)}
                            disabled={r.status === 'removed'}
                          />
                        </td>
                        <td className="p-2">
                          <input
                            className="border-rule w-full rounded border px-1 py-0.5 font-mono text-xs"
                            value={r.type}
                            onChange={(e) => updateRecord(r.key, 'type', e.target.value)}
                            disabled={r.status === 'removed'}
                          />
                        </td>
                        <td className="p-2">
                          <input
                            className="border-rule w-full rounded border px-1 py-0.5 font-mono text-xs"
                            value={r.data}
                            onChange={(e) => updateRecord(r.key, 'data', e.target.value)}
                            disabled={r.status === 'removed'}
                          />
                        </td>
                        <td className="p-2 text-right">
                          {r.status === 'added' ? (
                            <button
                              onClick={() => deleteRow(r.key)}
                              className="text-red-600 hover:underline"
                            >
                              del
                            </button>
                          ) : (
                            <button
                              onClick={() => toggleRemove(r.key)}
                              className="text-red-600 hover:underline"
                            >
                              {r.status === 'removed' ? 'undo' : 'rm'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {records.length === 0 && (
                      <tr>
                        <td colSpan={5} className="text-ink-muted p-6 text-center">
                          No records. Click "Load from latest" or "+ Add Record".
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Actions */}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={simplePush}
                disabled={working}
                className="bg-ink text-parchment rounded px-4 py-2 text-xs font-medium disabled:opacity-50"
              >
                Simple Push
              </button>
              <button
                onClick={negotiatePush}
                disabled={working}
                className="rounded border border-blue-600 px-4 py-2 text-xs font-medium text-blue-600 disabled:opacity-50"
              >
                Negotiate Push
              </button>
              <div className="flex items-center gap-1">
                <button
                  onClick={batchPush}
                  disabled={working}
                  className="rounded border border-purple-600 px-4 py-2 text-xs font-medium text-purple-600 disabled:opacity-50"
                >
                  Batch Push
                </button>
                <label className="text-ink-muted ml-1 text-xs">
                  batch size:
                  <input
                    type="number"
                    min={1}
                    className="border-rule ml-1 w-12 rounded border px-1 py-0.5 text-center font-mono text-xs"
                    value={batchSize}
                    onChange={(e) => setBatchSize(Number(e.target.value) || 1)}
                  />
                </label>
              </div>
              <label className="text-ink-muted flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={stripUnknownFields}
                  onChange={(e) => setStripUnknownFields(e.target.checked)}
                />
                strip unknown fields
              </label>
              {working && <span className="text-ink-muted animate-pulse text-xs">Working...</span>}
            </div>
          </div>

          {/* Right column: Log */}
          <div className="border-rule flex flex-col rounded border">
            <div className="border-rule flex items-center justify-between border-b px-3 py-2">
              <span className="text-xs font-semibold">Log ({logs.length})</span>
              <div className="flex gap-2">
                <button onClick={copyLogs} className="text-link text-xs hover:underline">
                  Copy all
                </button>
                <button
                  onClick={() => setLogs([])}
                  className="text-xs text-red-600 hover:underline"
                >
                  Clear
                </button>
              </div>
            </div>
            <div
              ref={logRef}
              className="flex-1 overflow-auto p-2"
              style={{ maxHeight: '80vh', minHeight: '400px' }}
            >
              {logs.map((l, i) => (
                <div
                  key={i}
                  className={`mb-2 rounded p-2 font-mono text-[11px] leading-relaxed ${
                    l.direction === 'req'
                      ? 'bg-blue-50 text-blue-900'
                      : l.direction === 'res'
                        ? 'bg-green-50 text-green-900'
                        : l.direction === 'error'
                          ? 'bg-red-50 text-red-900'
                          : 'bg-gray-50 text-gray-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">
                      {l.direction === 'req'
                        ? '>>>'
                        : l.direction === 'res'
                          ? '<<<'
                          : l.direction === 'error'
                            ? '!!!'
                            : '---'}
                    </span>
                    <span className="opacity-60">{l.time}</span>
                    {l.method && <span className="font-semibold">{l.method}</span>}
                    {l.url && <span className="truncate opacity-80">{l.url}</span>}
                    {l.status && (
                      <span
                        className={
                          l.status >= 400 ? 'font-semibold text-red-700' : 'text-green-700'
                        }
                      >
                        {l.status}
                      </span>
                    )}
                    {l.duration != null && <span className="opacity-50">{l.duration}ms</span>}
                  </div>
                  {l.body && (
                    <pre className="mt-1 max-h-40 overflow-auto text-[10px] break-all whitespace-pre-wrap opacity-80">
                      {l.body}
                    </pre>
                  )}
                </div>
              ))}
              {logs.length === 0 && (
                <div className="text-ink-muted py-8 text-center text-xs">
                  No log entries yet. Click "Fetch Latest" to start.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  )
}

function tryParse(json: string): any {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}
