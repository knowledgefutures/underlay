import { autocompletion, type Completion, type CompletionContext } from '@codemirror/autocomplete'
import { defaultKeymap, history as cmHistory, historyKeymap } from '@codemirror/commands'
import { sql, SQLite } from '@codemirror/lang-sql'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { Lock } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type SqlJsDatabase = any
type SqlJs = any

interface CollectionInfo {
  ownerSlug: string
  slug: string
  name: string
  description?: string
  public: boolean
  latestVersion: number | null
  latestSemver: string | null
  recordCount: number
}

interface LoadedCollection {
  key: string
  ownerSlug: string
  slug: string
  version: number
  semver: string
  name: string
  public: boolean
  ddl: string
  recordCount: number
}

interface QueryResult {
  columns: string[]
  rows: any[][]
}

interface HistoryEntry {
  id: number
  sql: string
  prompt?: string | undefined
  reasoning?: string | undefined
  result: QueryResult | null
  error?: string | undefined
  rawResponse?: string | undefined
  durationMs?: number | undefined
  collections: string[]
  timestamp: number
}

function isSqlQuery(input: string): boolean {
  const trimmed = input.trim().toUpperCase()
  return (
    trimmed.startsWith('SELECT') ||
    trimmed.startsWith('WITH') ||
    trimmed.startsWith('PRAGMA') ||
    trimmed.startsWith('EXPLAIN')
  )
}

function downloadCsv(result: QueryResult, filename: string) {
  const escape = (v: any) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  const lines = [
    result.columns.map(escape).join(','),
    ...result.rows.map((row) => row.map(escape).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function QueryExplorer() {
  const [sqlJs, setSqlJs] = useState<SqlJs | null>(null)
  const [db, setDb] = useState<SqlJsDatabase | null>(null)
  const [sqlJsReady, setSqlJsReady] = useState(false)
  const [sqlJsError, setSqlJsError] = useState('')
  const [searchResults, setSearchResults] = useState<CollectionInfo[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedForVersion, setSelectedForVersion] = useState<CollectionInfo | null>(null)
  const [availableVersions, setAvailableVersions] = useState<
    { number: number; semver: string; recordCount: number; message?: string }[]
  >([])
  const [loadedCollections, setLoadedCollections] = useState<LoadedCollection[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMessage, setLoadingMessage] = useState('')

  // Input
  const [isRunning, setIsRunning] = useState(false)

  // History + results
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    try {
      const stored = localStorage.getItem('query-explorer-history')
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })
  const [selectedEntry, setSelectedEntry] = useState<HistoryEntry | null>(null)

  // Collection selector
  const [showCollections, setShowCollections] = useState(false)
  const [collectionSearch, setCollectionSearch] = useState('')

  const editorContainerRef = useRef<HTMLDivElement>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const sqlCompartment = useRef(new Compartment())
  const completionCompartment = useRef(new Compartment())
  const searchPanelRef = useRef<HTMLDivElement>(null)
  const nextId = useRef(1)

  // Close search panel on click outside
  useEffect(() => {
    if (!showCollections) return
    function handleClick(e: MouseEvent) {
      if (searchPanelRef.current && !searchPanelRef.current.contains(e.target as Node)) {
        setShowCollections(false)
        setCollectionSearch('')
        setSelectedForVersion(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showCollections])

  // Sync nextId with loaded history
  useEffect(() => {
    if (history.length > 0) {
      nextId.current = Math.max(...history.map((h) => h.id)) + 1
    }
  }, [])

  // Persist history to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('query-explorer-history', JSON.stringify(history))
    } catch {
      /* quota exceeded — ignore */
    }
  }, [history])

  const clearHistory = useCallback(() => {
    setHistory([])
    setSelectedEntry(null)
    localStorage.removeItem('query-explorer-history')
  }, [])

  // Initialize sql.js
  useEffect(() => {
    async function initSqlJs() {
      try {
        const initSqlJsModule = (await import('sql.js')).default
        const SQL = await initSqlJsModule({
          locateFile: () => `/sql-wasm.wasm`,
        })
        setSqlJs(SQL)
        setSqlJsReady(true)
      } catch (e: any) {
        console.error('Failed to initialize sql.js:', e)
        setSqlJsError(e.message || 'Failed to load SQL engine')
      }
    }
    initSqlJs()
  }, [])

  // Build schema map for CodeMirror SQL autocomplete
  // Build completions with collection labels as detail
  const completionData = useMemo(() => {
    const items: Completion[] = []
    const searchTerms: string[] = []
    for (const lc of loadedCollections) {
      const tableRegex = /CREATE TABLE "([^"]+)"\s*\(([\s\S]*?)\);/g
      let match
      while ((match = tableRegex.exec(lc.ddl)) !== null) {
        const rawName = match[1]!
        const tableName =
          loadedCollections.length > 1 ? `${lc.slug.replace(/-/g, '_')}__${rawName}` : rawName
        const detail = `${lc.ownerSlug}/${lc.slug}`
        items.push({ label: tableName, type: 'keyword', detail })
        searchTerms.push(`${tableName} ${lc.slug} ${lc.ownerSlug} ${rawName}`.toLowerCase())
        const colDefs = match[2]!
        for (const col of colDefs.split(',')) {
          const colMatch = col.trim().match(/^"([^"]+)"/)
          if (colMatch) {
            const colName = colMatch[1]!
            items.push({ label: colName, type: 'property', detail: `· ${tableName}` })
            searchTerms.push(`${colName} ${tableName} ${lc.slug}`.toLowerCase())
          }
        }
      }
    }
    return { items, searchTerms }
  }, [loadedCollections])

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!editorContainerRef.current || editorViewRef.current) return

    const submitHandler = keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          const val = view.state.doc.toString()
          if (val.trim()) {
            // Dispatch a custom event the component can listen for
            editorContainerRef.current?.dispatchEvent(new CustomEvent('cm-submit', { detail: val }))
          }
          return true
        },
      },
      {
        key: 'Shift-Enter',
        run: () => false, // Let default (newline) happen
      },
    ])

    const state = EditorState.create({
      doc: '',
      extensions: [
        submitHandler,
        defaultKeymap.filter((k) => k.key !== 'Enter').length
          ? keymap.of(defaultKeymap)
          : keymap.of(defaultKeymap),
        keymap.of(historyKeymap),
        cmHistory(),
        sqlCompartment.current.of(sql({ dialect: SQLite })),
        completionCompartment.current.of(autocompletion({ icons: false, override: [] })),
        cmPlaceholder('SELECT * FROM ...'),
        EditorView.lineWrapping,
        EditorView.theme({
          '&': { fontSize: '13px', maxHeight: '80px', fontFamily: 'ui-monospace, monospace' },
          '.cm-content': { padding: '8px 10px', minHeight: '42px' },
          '.cm-editor': { borderRadius: '0' },
          '.cm-focused': { outline: 'none' },
          '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--color-ink)' },
          '.cm-scroller': { overflow: 'auto' },
        }),
        EditorView.baseTheme({
          '&.cm-editor': { backgroundColor: 'var(--color-parchment, #fff)' },
        }),
        EditorView.theme({
          '.cm-tooltip-autocomplete': {
            border: '1px solid var(--color-rule, #e5e2db)',
            backgroundColor: 'var(--color-parchment, #fff)',
            fontFamily: 'ui-monospace, monospace',
            fontSize: '12px',
          },
          '.cm-tooltip-autocomplete ul li': {
            padding: '2px 8px',
          },
          '.cm-tooltip-autocomplete ul li[aria-selected]': {
            backgroundColor: 'var(--color-parchment-dark, #f5f0e8)',
            color: 'var(--color-ink, #1a1a1a)',
          },
          '.cm-completionDetail': {
            fontStyle: 'normal',
            opacity: '0.5',
            marginLeft: '8px',
            fontSize: '11px',
          },
        }),
      ],
    })

    const view = new EditorView({ state, parent: editorContainerRef.current })
    editorViewRef.current = view

    return () => {
      view.destroy()
      editorViewRef.current = null
    }
  }, []) // Only mount once

  // Update SQL language + completions when schema changes
  useEffect(() => {
    if (!editorViewRef.current) return
    const { items, searchTerms } = completionData
    const completer = (ctx: CompletionContext) => {
      const word = ctx.matchBefore(/\w*/)
      if (!word || (word.from === word.to && !ctx.explicit)) return null
      const typed = word.text.toLowerCase()
      const filtered = typed ? items.filter((_, i) => searchTerms[i]!.includes(typed)) : items
      return { from: word.from, options: filtered, filter: false }
    }
    editorViewRef.current.dispatch({
      effects: [
        sqlCompartment.current.reconfigure(sql({ dialect: SQLite })),
        completionCompartment.current.reconfigure(
          autocompletion({ icons: false, override: [completer] }),
        ),
      ],
    })
  }, [completionData])

  // Clear editor content
  const clearEditor = useCallback(() => {
    const view = editorViewRef.current
    if (!view) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
  }, [])

  // Debounced server-side collection search
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!collectionSearch || collectionSearch.trim().length < 2) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }
    setSearchLoading(true)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/query/collections/search?q=${encodeURIComponent(collectionSearch.trim())}`,
        )
        if (res.ok) {
          const data = await res.json()
          setSearchResults(data)
        }
      } catch {
        /* ignore */
      }
      setSearchLoading(false)
    }, 250)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [collectionSearch])

  // Fetch versions when a collection is selected for version picking
  useEffect(() => {
    if (!selectedForVersion) {
      setAvailableVersions([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(
          `/api/query/collections/${selectedForVersion.ownerSlug}/${selectedForVersion.slug}/versions`,
        )
        if (res.ok && !cancelled) {
          setAvailableVersions(await res.json())
        }
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedForVersion])

  // Load a collection into the workspace
  const loadCollection = useCallback(
    async (c: CollectionInfo, version?: number, semver?: string) => {
      if (!sqlJs) return
      const v = version ?? c.latestVersion
      if (v === null) return
      const sv = semver ?? c.latestSemver ?? `${v}.0.0`

      const key = `${c.ownerSlug}/${c.slug}:${v}`
      if (loadedCollections.some((lc) => lc.key === key)) return

      setLoading(true)
      setLoadingMessage(`Loading ${c.ownerSlug}/${c.slug} v${v}...`)

      try {
        const sqliteRes = await fetch(`/api/query/sqlite/${c.ownerSlug}/${c.slug}/${v}`)
        if (!sqliteRes.ok) throw new Error('Failed to fetch SQLite file')
        const arrayBuffer = await sqliteRes.arrayBuffer()

        const ddlRes = await fetch(`/api/query/ddl/${c.ownerSlug}/${c.slug}/${v}`)
        const { ddl } = await ddlRes.json()

        const newLoaded: LoadedCollection = {
          key,
          ownerSlug: c.ownerSlug,
          slug: c.slug,
          version: v,
          semver: sv,
          name: c.name,
          public: c.public,
          ddl,
          recordCount: c.recordCount,
        }

        const allLoaded = [...loadedCollections, newLoaded]

        if (allLoaded.length === 1) {
          const newDb = new sqlJs.Database(new Uint8Array(arrayBuffer))
          if (db) db.close()
          setDb(newDb)
        } else {
          // Multi-collection: create merged db with prefixed tables + _source column
          const newDb = new sqlJs.Database()
          if (db) db.close()

          for (const lc of allLoaded) {
            const res =
              lc.key === key
                ? { arrayBuffer: () => Promise.resolve(arrayBuffer) }
                : await fetch(`/api/query/sqlite/${lc.ownerSlug}/${lc.slug}/${lc.version}`)
            const buf = await (res as any).arrayBuffer()
            const tempDb = new sqlJs.Database(new Uint8Array(buf))

            const tables = tempDb.exec("SELECT name, sql FROM sqlite_master WHERE type='table'")
            if (tables.length > 0) {
              for (const row of tables[0].values) {
                const tableName = row[0] as string
                const createSql = row[1] as string
                const prefix = lc.slug.replace(/-/g, '_')
                const prefixedCreate = createSql
                  .replace(`CREATE TABLE "${tableName}"`, `CREATE TABLE "${prefix}__${tableName}"`)
                  .replace(/\)$/, `,\n  "_source" TEXT\n)`)
                try {
                  newDb.exec(prefixedCreate)
                } catch {
                  continue
                }

                const data = tempDb.exec(`SELECT * FROM "${tableName}"`)
                if (data.length > 0 && data[0].values.length > 0) {
                  const cols = [...data[0].columns, '_source']
                  const placeholders = cols.map(() => '?').join(', ')
                  const insertSql = `INSERT INTO "${prefix}__${tableName}" (${cols
                    .map((c: string) => `"${c}"`)
                    .join(', ')}) VALUES (${placeholders})`
                  const sourceLabel = `${lc.ownerSlug}/${lc.slug}`
                  const stmt = newDb.prepare(insertSql)
                  for (const r of data[0].values) stmt.run([...r, sourceLabel])
                  stmt.free()
                }
              }
            }
            tempDb.close()
          }
          setDb(newDb)
        }

        setLoadedCollections(allLoaded)
      } catch (e: any) {
        console.error('Load collection error:', e)
      } finally {
        setLoading(false)
        setLoadingMessage('')
      }
    },
    [sqlJs, db, loadedCollections],
  )

  const removeCollection = useCallback(
    async (key: string) => {
      const remaining = loadedCollections.filter((lc) => lc.key !== key)
      setLoadedCollections(remaining)

      if (remaining.length === 0) {
        if (db) db.close()
        setDb(null)
        setSelectedEntry(null)
        return
      }

      if (!sqlJs) return
      const newDb = new sqlJs.Database()
      if (db) db.close()

      for (const lc of remaining) {
        const res = await fetch(`/api/query/sqlite/${lc.ownerSlug}/${lc.slug}/${lc.version}`)
        const buf = await res.arrayBuffer()
        const tempDb = new sqlJs.Database(new Uint8Array(buf))

        if (remaining.length === 1) {
          const tables = tempDb.exec("SELECT name, sql FROM sqlite_master WHERE type='table'")
          if (tables.length > 0) {
            for (const row of tables[0].values) {
              const createSql = row[1] as string
              try {
                newDb.exec(createSql)
              } catch {
                continue
              }
              const tableName = row[0] as string
              const data = tempDb.exec(`SELECT * FROM "${tableName}"`)
              if (data.length > 0 && data[0].values.length > 0) {
                const cols = data[0].columns
                const placeholders = cols.map(() => '?').join(', ')
                const stmt = newDb.prepare(
                  `INSERT INTO "${tableName}" (${cols
                    .map((c: string) => `"${c}"`)
                    .join(', ')}) VALUES (${placeholders})`,
                )
                for (const r of data[0].values) stmt.run(r)
                stmt.free()
              }
            }
          }
        } else {
          const tables = tempDb.exec("SELECT name, sql FROM sqlite_master WHERE type='table'")
          if (tables.length > 0) {
            for (const row of tables[0].values) {
              const tableName = row[0] as string
              const createSql = row[1] as string
              const prefix = lc.slug.replace(/-/g, '_')
              const prefixedCreate = createSql
                .replace(`CREATE TABLE "${tableName}"`, `CREATE TABLE "${prefix}__${tableName}"`)
                .replace(/\)$/, `,\n  "_source" TEXT\n)`)
              try {
                newDb.exec(prefixedCreate)
              } catch {
                continue
              }
              const data = tempDb.exec(`SELECT * FROM "${tableName}"`)
              if (data.length > 0 && data[0].values.length > 0) {
                const cols = [...data[0].columns, '_source']
                const placeholders = cols.map(() => '?').join(', ')
                const sourceLabel = `${lc.ownerSlug}/${lc.slug}`
                const stmt = newDb.prepare(
                  `INSERT INTO "${prefix}__${tableName}" (${cols
                    .map((c: string) => `"${c}"`)
                    .join(', ')}) VALUES (${placeholders})`,
                )
                for (const r of data[0].values) stmt.run([...r, sourceLabel])
                stmt.free()
              }
            }
          }
        }
        tempDb.close()
      }

      setDb(newDb)
    },
    [sqlJs, db, loadedCollections],
  )

  // Execute a SQL query directly
  const executeSql = useCallback(
    (sql: string, prompt?: string, reasoning?: string, durationMs?: number) => {
      if (!db) return
      const collectionLabels = loadedCollections.map(
        (lc) => `${lc.ownerSlug}/${lc.slug} v${lc.version}`,
      )

      let result: QueryResult | null = null
      let error: string | undefined

      try {
        const results = db.exec(sql)
        if (results.length === 0) {
          result = { columns: [], rows: [] }
        } else {
          result = { columns: results[0].columns, rows: results[0].values }
        }
      } catch (e: any) {
        error = e.message || 'Query failed'
      }

      const entry: HistoryEntry = {
        id: nextId.current++,
        sql,
        prompt,
        reasoning,
        durationMs,
        result,
        error,
        collections: collectionLabels,
        timestamp: Date.now(),
      }

      setHistory((prev) => [entry, ...prev])
      setSelectedEntry(entry)
    },
    [db, loadedCollections],
  )

  // Handle input submission
  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim()
      if (!trimmed || !db) return

      setIsRunning(true)

      if (isSqlQuery(trimmed)) {
        // Direct SQL execution
        executeSql(trimmed)
        clearEditor()
      } else {
        // Natural language → LLM generates SQL (server handles DDL + sample assembly)
        setSelectedEntry(null)
        const collectionRefs = loadedCollections.map((lc) => ({
          owner: lc.ownerSlug,
          slug: lc.slug,
          version: lc.version,
        }))

        try {
          const t0 = performance.now()
          const res = await fetch('/api/query/generate-sql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collections: collectionRefs, question: trimmed }),
          })
          const durationMs = Math.round(performance.now() - t0)

          if (!res.ok) {
            const data = await res.json()
            const entry: HistoryEntry = {
              id: nextId.current++,
              sql: data.sql || '',
              prompt: trimmed,
              reasoning: data.reasoning,
              durationMs,
              result: null,
              error: data.error || data.message || 'Failed to generate SQL',
              rawResponse: data.rawResponse,
              collections: loadedCollections.map(
                (lc) => `${lc.ownerSlug}/${lc.slug} v${lc.version}`,
              ),
              timestamp: Date.now(),
            }
            setHistory((prev) => [entry, ...prev])
            setSelectedEntry(entry)
          } else {
            const { sql, reasoning } = await res.json()
            executeSql(sql, trimmed, reasoning, durationMs)
          }
        } catch (e: any) {
          const entry: HistoryEntry = {
            id: nextId.current++,
            sql: '',
            prompt: trimmed,
            result: null,
            error: e.message || 'Network error',
            collections: loadedCollections.map((lc) => `${lc.ownerSlug}/${lc.slug} v${lc.version}`),
            timestamp: Date.now(),
          }
          setHistory((prev) => [entry, ...prev])
          setSelectedEntry(entry)
        }
        clearEditor()
      }

      setIsRunning(false)
    },
    [db, loadedCollections, executeSql, clearEditor],
  )

  // Listen for CodeMirror submit events
  useEffect(() => {
    const container = editorContainerRef.current
    if (!container) return
    const handler = (e: Event) => {
      const val = (e as CustomEvent).detail
      if (val && !isRunning) handleSubmit(val)
    }
    container.addEventListener('cm-submit', handler)
    return () => container.removeEventListener('cm-submit', handler)
  }, [isRunning, handleSubmit])

  // Share: encode current state to URL hash
  const [copied, setCopied] = useState(false)
  const shareQuery = useCallback(
    (sqlText: string) => {
      const payload = {
        c: loadedCollections.map((lc) => ({ o: lc.ownerSlug, s: lc.slug, v: lc.version })),
        q: sqlText,
      }
      const hash = btoa(JSON.stringify(payload))
      const url = `${window.location.origin}${window.location.pathname}#${hash}`
      navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    },
    [loadedCollections],
  )

  // Load shared state from URL hash once sql.js is ready
  useEffect(() => {
    if (!sqlJs) return
    const hash = window.location.hash.slice(1)
    if (!hash) return
    try {
      const payload = JSON.parse(atob(hash))
      if (!payload.c || !Array.isArray(payload.c)) return
      // Load each collection from the hash
      for (const ref of payload.c) {
        const info: CollectionInfo = {
          ownerSlug: ref.o,
          slug: ref.s,
          name: `${ref.o}/${ref.s}`,
          public: true,
          latestVersion: ref.v,
          latestSemver: '',
          recordCount: 0,
        }
        loadCollection(info, ref.v)
      }
      // Set the query in the editor after a short delay for CM to mount
      if (payload.q) {
        setTimeout(() => {
          const view = editorViewRef.current
          if (view) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: payload.q } })
          }
        }, 500)
      }
      // Clear the hash so it doesn't reload on refresh
      window.history.replaceState(null, '', window.location.pathname)
    } catch {
      /* invalid hash, ignore */
    }
  }, [sqlJs])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel: input + history */}
      <div className="border-rule bg-parchment flex w-[420px] min-w-[360px] flex-col overflow-hidden border-r">
        {/* Input area */}
        <div className="border-rule border-b p-3">
          {/* Collection search + add */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {loadedCollections.map((lc) => (
              <span
                key={lc.key}
                className="bg-parchment-dark border-rule inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[11px]"
              >
                {!lc.public && <Lock size={9} className="text-ink-muted" />}
                {lc.ownerSlug}/{lc.slug}
                <span className="text-ink-muted">{lc.semver}</span>
                <button
                  onClick={() => removeCollection(lc.key)}
                  className="text-ink-muted hover:text-ink leading-none"
                >
                  ×
                </button>
              </span>
            ))}
            {!showCollections && (
              <button
                onClick={() => {
                  setShowCollections(true)
                  setCollectionSearch('')
                }}
                className="border-rule hover:bg-parchment-dark text-ink-muted border px-1.5 py-0.5 font-mono text-[11px]"
              >
                + add collection
              </button>
            )}
          </div>

          {/* Collection search input */}
          {showCollections && (
            <div ref={searchPanelRef} className="border-rule bg-parchment mb-2 border p-2">
              {!selectedForVersion ? (
                <>
                  <input
                    type="search"
                    placeholder="Search by owner or collection name..."
                    className="bg-parchment-dark border-rule placeholder:text-ink-muted focus:border-ink w-full border px-2 py-1 font-mono text-xs focus:outline-none"
                    value={collectionSearch}
                    onChange={(e) => setCollectionSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setShowCollections(false)
                        setCollectionSearch('')
                      }
                    }}
                    autoFocus
                  />
                  {searchLoading && (
                    <div className="text-ink-muted mt-1 px-1 font-mono text-[11px]">
                      Searching...
                    </div>
                  )}
                  {collectionSearch.length >= 2 && !searchLoading && (
                    <div className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto">
                      {searchResults.length === 0 ? (
                        <div className="text-ink-muted px-2 py-1 font-mono text-xs">No matches</div>
                      ) : (
                        searchResults.map((c) => {
                          const alreadyLoaded = loadedCollections.some(
                            (lc) => lc.ownerSlug === c.ownerSlug && lc.slug === c.slug,
                          )
                          return (
                            <div
                              key={`${c.ownerSlug}/${c.slug}`}
                              className={`flex items-stretch font-mono text-xs ${
                                alreadyLoaded ? 'opacity-40' : ''
                              }`}
                            >
                              <button
                                onClick={() => {
                                  loadCollection(c)
                                }}
                                disabled={loading || alreadyLoaded}
                                className="hover:bg-parchment-dark min-w-0 flex-1 px-2 py-1 text-left disabled:cursor-not-allowed"
                              >
                                <div className="truncate font-medium">
                                  {!c.public && (
                                    <Lock size={10} className="text-ink-muted mr-1 inline-block" />
                                  )}
                                  {c.ownerSlug}/{c.slug}
                                </div>
                                <div className="text-ink-muted truncate">
                                  {c.recordCount}r
                                  {c.name && c.name !== c.slug ? ` · ${c.name}` : ''}
                                </div>
                              </button>
                              <button
                                onClick={() => setSelectedForVersion(c)}
                                disabled={loading || alreadyLoaded}
                                className="border-rule text-ink-muted hover:bg-parchment-dark hover:text-ink flex w-16 shrink-0 items-center justify-center border-l text-[11px] disabled:cursor-not-allowed"
                                title="Choose specific version"
                              >
                                {c.latestSemver ?? `v${c.latestVersion}`}
                              </button>
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="font-mono text-xs font-medium">
                      {selectedForVersion.ownerSlug}/{selectedForVersion.slug}
                    </span>
                    <button
                      onClick={() => setSelectedForVersion(null)}
                      className="text-ink-muted hover:text-ink font-mono text-[11px]"
                    >
                      ← back
                    </button>
                  </div>
                  <div className="text-ink-muted mb-1 font-mono text-[10px]">Select version:</div>
                  <div className="max-h-40 space-y-0.5 overflow-y-auto">
                    {availableVersions.length === 0 ? (
                      <div className="text-ink-muted px-2 py-1 font-mono text-xs">
                        Loading versions...
                      </div>
                    ) : (
                      availableVersions.map((v) => {
                        const alreadyLoaded = loadedCollections.some(
                          (lc) =>
                            lc.ownerSlug === selectedForVersion.ownerSlug &&
                            lc.slug === selectedForVersion.slug &&
                            lc.version === v.number,
                        )
                        return (
                          <button
                            key={v.number}
                            onClick={() => {
                              loadCollection(selectedForVersion, v.number, v.semver)
                              setSelectedForVersion(null)
                            }}
                            disabled={loading || alreadyLoaded}
                            className="hover:bg-parchment-dark w-full px-2 py-1 text-left font-mono text-xs disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <span className="font-medium">{v.semver}</span>
                            <span className="text-ink-muted ml-1">({v.recordCount}r)</span>
                            {v.message && (
                              <span className="text-ink-muted ml-1">— {v.message}</span>
                            )}
                          </button>
                        )
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Loading indicator */}
          {loading && (
            <div className="text-ink-muted mb-2 animate-pulse font-mono text-[11px]">
              {loadingMessage}
            </div>
          )}

          {/* SQL / natural language input (CodeMirror) */}
          <div
            ref={editorContainerRef}
            className={`border-rule w-full border font-mono text-sm ${
              loadedCollections.length === 0 || isRunning ? 'pointer-events-none opacity-50' : ''
            }`}
            onSubmit={(e) => e.preventDefault()}
          />
          {isRunning && (
            <div className="text-ink-muted mt-1 animate-pulse font-mono text-[11px]">
              Generating query...
            </div>
          )}
        </div>

        {/* History */}
        <div className="flex-1 overflow-y-auto">
          {history.length > 0 && (
            <div className="flex items-center justify-between px-3 pt-2 pb-1">
              <span className="text-ink-muted font-mono text-[10px] tracking-wide uppercase">
                History
              </span>
              <button
                onClick={clearHistory}
                className="text-ink-muted font-mono text-[10px] hover:text-red-700"
              >
                Clear
              </button>
            </div>
          )}
          {history.length === 0 && (
            <div className="text-ink-muted p-3 text-xs">
              {sqlJsError ? (
                <span className="text-red-700">{sqlJsError}</span>
              ) : !sqlJsReady ? (
                'Loading SQL engine...'
              ) : loadedCollections.length === 0 ? (
                'Add a collection above, then type a SQL query.'
              ) : (
                'Type a query and press Enter. Results appear on the right.'
              )}
            </div>
          )}
          {history.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSelectedEntry(entry)}
              className={`border-rule hover:bg-parchment-dark w-full border-b px-3 py-2.5 text-left transition-colors ${
                selectedEntry?.id === entry.id ? 'bg-parchment-dark' : ''
              }`}
            >
              {/* Prompt (if LLM-generated) */}
              {entry.prompt && (
                <div className="text-ink-muted mb-0.5 truncate text-[11px] italic">
                  "{entry.prompt}"
                </div>
              )}
              {/* SQL */}
              <div className="text-ink truncate font-mono text-xs">
                {entry.sql || <span className="text-red-700">Failed</span>}
              </div>
              {/* Meta line */}
              <div className="text-ink-muted mt-0.5 flex items-center gap-2 text-[10px]">
                <span>{entry.collections.join(', ')}</span>
                {entry.result && <span>· {entry.result.rows.length} rows</span>}
                {entry.error && <span className="text-red-700">· error</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right panel: results */}
      <div className="bg-parchment flex min-h-0 flex-1 flex-col overflow-hidden">
        {isRunning && !selectedEntry ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-ink-muted animate-pulse font-mono text-sm">Generating query...</p>
          </div>
        ) : !selectedEntry ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-ink-muted font-mono text-sm">Results will appear here</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Result header: full context (fixed) */}
            <div className="border-rule shrink-0 space-y-2 border-b px-4 py-3">
              {/* Collections row */}
              <div className="flex items-center justify-between gap-2">
                <div className="text-ink-muted min-w-0 truncate font-mono text-[11px]">
                  {selectedEntry.collections.join(' · ')}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {selectedEntry.durationMs !== undefined && (
                    <span className="text-ink-muted font-mono text-[11px]">
                      {selectedEntry.durationMs >= 1000
                        ? `${(selectedEntry.durationMs / 1000).toFixed(1)}s`
                        : `${selectedEntry.durationMs}ms`}
                    </span>
                  )}
                  {selectedEntry.result && (
                    <span className="text-ink-muted font-mono text-[11px]">
                      {selectedEntry.result.rows.length} row
                      {selectedEntry.result.rows.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {selectedEntry.result && selectedEntry.result.rows.length > 0 && (
                    <button
                      onClick={() =>
                        downloadCsv(selectedEntry.result!, `query-${selectedEntry.id}.csv`)
                      }
                      className="border-rule hover:bg-parchment-dark text-ink-muted hover:text-ink border px-2 py-0.5 font-mono text-[11px]"
                    >
                      ↓ CSV
                    </button>
                  )}
                  {selectedEntry.sql && (
                    <button
                      onClick={() => shareQuery(selectedEntry.sql)}
                      className="border-rule hover:bg-parchment-dark text-ink-muted hover:text-ink border px-2 py-0.5 font-mono text-[11px]"
                    >
                      {copied ? '✓ Copied' : 'Share'}
                    </button>
                  )}
                </div>
              </div>

              {/* Prompt (if LLM-generated) */}
              {selectedEntry.prompt && (
                <div className="text-ink-muted text-xs italic">"{selectedEntry.prompt}"</div>
              )}

              {/* Full SQL */}
              {selectedEntry.sql && (
                <pre className="bg-parchment-dark border-rule overflow-x-auto border px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
                  {selectedEntry.sql}
                </pre>
              )}

              {/* LLM reasoning */}
              {selectedEntry.reasoning && (
                <div className="text-ink-muted border-rule border-l-2 pl-2 text-[11px]">
                  {selectedEntry.reasoning}
                </div>
              )}
            </div>

            {/* Scrollable results area */}
            <div className="min-h-0 flex-1 overflow-auto">
              {/* Error display */}
              {selectedEntry.error && (
                <div className="border-b border-red-200 bg-red-50 px-4 py-3 font-mono text-sm text-red-800">
                  {selectedEntry.error}
                </div>
              )}

              {/* Raw LLM response for debugging */}
              {selectedEntry.rawResponse && (
                <div className="border-rule border-b px-4 py-3">
                  <div className="text-ink-muted mb-1 font-mono text-[10px] tracking-wide uppercase">
                    Raw LLM Output
                  </div>
                  <pre className="bg-parchment-dark border-rule text-ink-light overflow-x-auto border px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
                    {selectedEntry.rawResponse}
                  </pre>
                </div>
              )}

              {/* Results table */}
              {selectedEntry.result && selectedEntry.result.columns.length > 0 && (
                <div className="px-4 py-3">
                  <table className="w-full font-mono text-xs">
                    <thead>
                      <tr className="border-rule border-b">
                        {selectedEntry.result.columns.map((col, i) => (
                          <th
                            key={i}
                            className="text-ink-light bg-parchment sticky top-0 px-2 py-1.5 text-left font-medium"
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {selectedEntry.result.rows.slice(0, 500).map((row, i) => (
                        <tr
                          key={i}
                          className="border-rule hover:bg-parchment-dark border-b last:border-0"
                        >
                          {row.map((cell, j) => (
                            <td key={j} className="max-w-xs truncate px-2 py-1">
                              {cell === null ? (
                                <span className="text-ink-muted italic">null</span>
                              ) : (
                                String(cell)
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {selectedEntry.result.rows.length > 500 && (
                    <div className="text-ink-muted mt-2 font-mono text-[11px]">
                      Showing 500 of {selectedEntry.result.rows.length} rows. Download CSV for full
                      results.
                    </div>
                  )}
                </div>
              )}

              {selectedEntry.result &&
                selectedEntry.result.columns.length === 0 &&
                !selectedEntry.error && (
                  <div className="px-4 py-8 text-center">
                    <p className="text-ink-muted font-mono text-sm">Query returned no results.</p>
                  </div>
                )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
