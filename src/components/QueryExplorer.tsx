import { useState, useEffect, useRef, useCallback } from "react";
import { Lock } from "lucide-react";

type SqlJsDatabase = any;
type SqlJs = any;

interface CollectionInfo {
  ownerSlug: string;
  slug: string;
  name: string;
  description?: string;
  public: boolean;
  latestVersion: number | null;
  latestSemver: string | null;
  recordCount: number;
}

interface LoadedCollection {
  key: string;
  ownerSlug: string;
  slug: string;
  version: number;
  semver: string;
  name: string;
  public: boolean;
  ddl: string;
  recordCount: number;
}

interface QueryResult {
  columns: string[];
  rows: any[][];
}

interface HistoryEntry {
  id: number;
  sql: string;
  prompt?: string | undefined;
  reasoning?: string | undefined;
  result: QueryResult | null;
  error?: string | undefined;
  rawResponse?: string | undefined;
  durationMs?: number | undefined;
  collections: string[];
  timestamp: number;
}

function isSqlQuery(input: string): boolean {
  const trimmed = input.trim().toUpperCase();
  return (
    trimmed.startsWith("SELECT") ||
    trimmed.startsWith("WITH") ||
    trimmed.startsWith("PRAGMA") ||
    trimmed.startsWith("EXPLAIN")
  );
}

function downloadCsv(result: QueryResult, filename: string) {
  const escape = (v: any) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [
    result.columns.map(escape).join(","),
    ...result.rows.map((row) => row.map(escape).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function QueryExplorer() {
  const [sqlJs, setSqlJs] = useState<SqlJs | null>(null);
  const [db, setDb] = useState<SqlJsDatabase | null>(null);
  const [sqlJsReady, setSqlJsReady] = useState(false);
  const [sqlJsError, setSqlJsError] = useState("");
  const [searchResults, setSearchResults] = useState<CollectionInfo[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedForVersion, setSelectedForVersion] = useState<CollectionInfo | null>(null);
  const [availableVersions, setAvailableVersions] = useState<{ number: number; semver: string; recordCount: number; message?: string }[]>([]);
  const [loadedCollections, setLoadedCollections] = useState<LoadedCollection[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");

  // Input
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  // History + results
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    try {
      const stored = localStorage.getItem("query-explorer-history");
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  });
  const [selectedEntry, setSelectedEntry] = useState<HistoryEntry | null>(null);

  // Collection selector
  const [showCollections, setShowCollections] = useState(false);
  const [collectionSearch, setCollectionSearch] = useState("");

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchPanelRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  // Close search panel on click outside
  useEffect(() => {
    if (!showCollections) return;
    function handleClick(e: MouseEvent) {
      if (searchPanelRef.current && !searchPanelRef.current.contains(e.target as Node)) {
        setShowCollections(false);
        setCollectionSearch("");
        setSelectedForVersion(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showCollections]);

  // Sync nextId with loaded history
  useEffect(() => {
    if (history.length > 0) {
      nextId.current = Math.max(...history.map((h) => h.id)) + 1;
    }
  }, []);

  // Persist history to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("query-explorer-history", JSON.stringify(history));
    } catch { /* quota exceeded — ignore */ }
  }, [history]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    setSelectedEntry(null);
    localStorage.removeItem("query-explorer-history");
  }, []);

  // Initialize sql.js
  useEffect(() => {
    async function initSqlJs() {
      try {
        const initSqlJsModule = (await import("sql.js")).default;
        const SQL = await initSqlJsModule({
          locateFile: () => `/sql-wasm.wasm`,
        });
        setSqlJs(SQL);
        setSqlJsReady(true);
      } catch (e: any) {
        console.error("Failed to initialize sql.js:", e);
        setSqlJsError(e.message || "Failed to load SQL engine");
      }
    }
    initSqlJs();
  }, []);

  // Debounced server-side collection search
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!collectionSearch || collectionSearch.trim().length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/query/collections/search?q=${encodeURIComponent(collectionSearch.trim())}`);
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data);
        }
      } catch { /* ignore */ }
      setSearchLoading(false);
    }, 250);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [collectionSearch]);

  // Fetch versions when a collection is selected for version picking
  useEffect(() => {
    if (!selectedForVersion) { setAvailableVersions([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/query/collections/${selectedForVersion.ownerSlug}/${selectedForVersion.slug}/versions`);
        if (res.ok && !cancelled) {
          setAvailableVersions(await res.json());
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [selectedForVersion]);

  // Load a collection into the workspace
  const loadCollection = useCallback(
    async (c: CollectionInfo, version?: number, semver?: string) => {
      if (!sqlJs) return;
      const v = version ?? c.latestVersion;
      if (v === null) return;
      const sv = semver ?? c.latestSemver ?? `${v}.0.0`;

      const key = `${c.ownerSlug}/${c.slug}:${v}`;
      if (loadedCollections.some((lc) => lc.key === key)) return;

      setLoading(true);
      setLoadingMessage(`Loading ${c.ownerSlug}/${c.slug} v${v}...`);

      try {
        const sqliteRes = await fetch(`/api/query/sqlite/${c.ownerSlug}/${c.slug}/${v}`);
        if (!sqliteRes.ok) throw new Error("Failed to fetch SQLite file");
        const arrayBuffer = await sqliteRes.arrayBuffer();

        const ddlRes = await fetch(`/api/query/ddl/${c.ownerSlug}/${c.slug}/${v}`);
        const { ddl } = await ddlRes.json();

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
        };

        const allLoaded = [...loadedCollections, newLoaded];

        if (allLoaded.length === 1) {
          const newDb = new sqlJs.Database(new Uint8Array(arrayBuffer));
          if (db) db.close();
          setDb(newDb);
        } else {
          // Multi-collection: create merged db with prefixed tables + _source column
          const newDb = new sqlJs.Database();
          if (db) db.close();

          for (const lc of allLoaded) {
            const res =
              lc.key === key
                ? { arrayBuffer: () => Promise.resolve(arrayBuffer) }
                : await fetch(`/api/query/sqlite/${lc.ownerSlug}/${lc.slug}/${lc.version}`);
            const buf = await (res as any).arrayBuffer();
            const tempDb = new sqlJs.Database(new Uint8Array(buf));

            const tables = tempDb.exec("SELECT name, sql FROM sqlite_master WHERE type='table'");
            if (tables.length > 0) {
              for (const row of tables[0].values) {
                const tableName = row[0] as string;
                const createSql = row[1] as string;
                const prefix = lc.slug.replace(/-/g, "_");
                const prefixedCreate = createSql
                  .replace(
                    `CREATE TABLE "${tableName}"`,
                    `CREATE TABLE "${prefix}__${tableName}"`,
                  )
                  .replace(/\)$/, `,\n  "_source" TEXT\n)`);
                try { newDb.exec(prefixedCreate); } catch { continue; }

                const data = tempDb.exec(`SELECT * FROM "${tableName}"`);
                if (data.length > 0 && data[0].values.length > 0) {
                  const cols = [...data[0].columns, "_source"];
                  const placeholders = cols.map(() => "?").join(", ");
                  const insertSql = `INSERT INTO "${prefix}__${tableName}" (${cols.map((c: string) => `"${c}"`).join(", ")}) VALUES (${placeholders})`;
                  const sourceLabel = `${lc.ownerSlug}/${lc.slug}`;
                  const stmt = newDb.prepare(insertSql);
                  for (const r of data[0].values) { stmt.run([...r, sourceLabel]); }
                  stmt.free();
                }
              }
            }
            tempDb.close();
          }
          setDb(newDb);
        }

        setLoadedCollections(allLoaded);
      } catch (e: any) {
        console.error("Load collection error:", e);
      } finally {
        setLoading(false);
        setLoadingMessage("");
      }
    },
    [sqlJs, db, loadedCollections],
  );

  const removeCollection = useCallback(
    async (key: string) => {
      const remaining = loadedCollections.filter((lc) => lc.key !== key);
      setLoadedCollections(remaining);

      if (remaining.length === 0) {
        if (db) db.close();
        setDb(null);
        setSelectedEntry(null);
        return;
      }

      if (!sqlJs) return;
      const newDb = new sqlJs.Database();
      if (db) db.close();

      for (const lc of remaining) {
        const res = await fetch(`/api/query/sqlite/${lc.ownerSlug}/${lc.slug}/${lc.version}`);
        const buf = await res.arrayBuffer();
        const tempDb = new sqlJs.Database(new Uint8Array(buf));

        if (remaining.length === 1) {
          const tables = tempDb.exec("SELECT name, sql FROM sqlite_master WHERE type='table'");
          if (tables.length > 0) {
            for (const row of tables[0].values) {
              const createSql = row[1] as string;
              try { newDb.exec(createSql); } catch { continue; }
              const tableName = row[0] as string;
              const data = tempDb.exec(`SELECT * FROM "${tableName}"`);
              if (data.length > 0 && data[0].values.length > 0) {
                const cols = data[0].columns;
                const placeholders = cols.map(() => "?").join(", ");
                const stmt = newDb.prepare(`INSERT INTO "${tableName}" (${cols.map((c: string) => `"${c}"`).join(", ")}) VALUES (${placeholders})`);
                for (const r of data[0].values) stmt.run(r);
                stmt.free();
              }
            }
          }
        } else {
          const tables = tempDb.exec("SELECT name, sql FROM sqlite_master WHERE type='table'");
          if (tables.length > 0) {
            for (const row of tables[0].values) {
              const tableName = row[0] as string;
              const createSql = row[1] as string;
              const prefix = lc.slug.replace(/-/g, "_");
              const prefixedCreate = createSql
                .replace(`CREATE TABLE "${tableName}"`, `CREATE TABLE "${prefix}__${tableName}"`)
                .replace(/\)$/, `,\n  "_source" TEXT\n)`);
              try { newDb.exec(prefixedCreate); } catch { continue; }
              const data = tempDb.exec(`SELECT * FROM "${tableName}"`);
              if (data.length > 0 && data[0].values.length > 0) {
                const cols = [...data[0].columns, "_source"];
                const placeholders = cols.map(() => "?").join(", ");
                const sourceLabel = `${lc.ownerSlug}/${lc.slug}`;
                const stmt = newDb.prepare(`INSERT INTO "${prefix}__${tableName}" (${cols.map((c: string) => `"${c}"`).join(", ")}) VALUES (${placeholders})`);
                for (const r of data[0].values) stmt.run([...r, sourceLabel]);
                stmt.free();
              }
            }
          }
        }
        tempDb.close();
      }

      setDb(newDb);
    },
    [sqlJs, db, loadedCollections],
  );

  // Execute a SQL query directly
  const executeSql = useCallback(
    (sql: string, prompt?: string, reasoning?: string, durationMs?: number) => {
      if (!db) return;
      const collectionLabels = loadedCollections.map((lc) => `${lc.ownerSlug}/${lc.slug} v${lc.version}`);

      let result: QueryResult | null = null;
      let error: string | undefined;

      try {
        const results = db.exec(sql);
        if (results.length === 0) {
          result = { columns: [], rows: [] };
        } else {
          result = { columns: results[0].columns, rows: results[0].values };
        }
      } catch (e: any) {
        error = e.message || "Query failed";
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
      };

      setHistory((prev) => [entry, ...prev]);
      setSelectedEntry(entry);
    },
    [db, loadedCollections],
  );

  // Handle input submission
  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || !db) return;

      setIsRunning(true);

      if (isSqlQuery(trimmed)) {
        // Direct SQL execution
        executeSql(trimmed);
        setInput("");
      } else {
        // Natural language → LLM generates SQL (server handles DDL + sample assembly)
        setSelectedEntry(null);
        const collectionRefs = loadedCollections.map((lc) => ({
          owner: lc.ownerSlug,
          slug: lc.slug,
          version: lc.version,
        }));

        try {
          const t0 = performance.now();
          const res = await fetch("/api/query/generate-sql", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ collections: collectionRefs, question: trimmed }),
          });
          const durationMs = Math.round(performance.now() - t0);

          if (!res.ok) {
            const data = await res.json();
            const entry: HistoryEntry = {
              id: nextId.current++,
              sql: data.sql || "",
              prompt: trimmed,
              reasoning: data.reasoning,
              durationMs,
              result: null,
              error: data.error || data.message || "Failed to generate SQL",
              rawResponse: data.rawResponse,
              collections: loadedCollections.map((lc) => `${lc.ownerSlug}/${lc.slug} v${lc.version}`),
              timestamp: Date.now(),
            };
            setHistory((prev) => [entry, ...prev]);
            setSelectedEntry(entry);
          } else {
            const { sql, reasoning } = await res.json();
            executeSql(sql, trimmed, reasoning, durationMs);
          }
        } catch (e: any) {
          const entry: HistoryEntry = {
            id: nextId.current++,
            sql: "",
            prompt: trimmed,
            result: null,
            error: e.message || "Network error",
            collections: loadedCollections.map((lc) => `${lc.ownerSlug}/${lc.slug} v${lc.version}`),
            timestamp: Date.now(),
          };
          setHistory((prev) => [entry, ...prev]);
          setSelectedEntry(entry);
        }
        setInput("");
      }

      setIsRunning(false);
    },
    [db, loadedCollections, executeSql],
  );

  const placeholder = loadedCollections.length === 0
    ? "Add a collection to start querying..."
    : loadedCollections.length === 1
      ? `SELECT * FROM "${Object.keys(JSON.parse('{}'))[0] || '...'}" LIMIT 10`
      : "SELECT * FROM ... or ask a question in plain English";

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel: input + history */}
      <div className="w-[420px] min-w-[360px] border-r border-rule flex flex-col bg-parchment overflow-hidden">
        {/* Input area */}
        <div className="p-3 border-b border-rule">
          {/* Collection search + add */}
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            {loadedCollections.map((lc) => (
              <span
                key={lc.key}
                className="inline-flex items-center gap-1 bg-parchment-dark border border-rule px-1.5 py-0.5 text-[11px] font-mono"
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
                onClick={() => { setShowCollections(true); setCollectionSearch(""); }}
                className="text-[11px] border border-rule px-1.5 py-0.5 hover:bg-parchment-dark font-mono text-ink-muted"
              >
                + add collection
              </button>
            )}
          </div>

          {/* Collection search input */}
          {showCollections && (
            <div ref={searchPanelRef} className="mb-2 border border-rule bg-parchment p-2">
              {!selectedForVersion ? (
                <>
                  <input
                    type="search"
                    placeholder="Search by owner or collection name..."
                    className="w-full bg-parchment-dark border border-rule px-2 py-1 text-xs font-mono placeholder:text-ink-muted focus:outline-none focus:border-ink"
                    value={collectionSearch}
                    onChange={(e) => setCollectionSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setShowCollections(false); setCollectionSearch(""); }
                    }}
                    autoFocus
                  />
                  {searchLoading && (
                    <div className="text-[11px] text-ink-muted font-mono mt-1 px-1">Searching...</div>
                  )}
                  {collectionSearch.length >= 2 && !searchLoading && (
                    <div className="mt-1.5 max-h-40 overflow-y-auto space-y-0.5">
                      {searchResults.length === 0 ? (
                        <div className="text-xs text-ink-muted px-2 py-1 font-mono">No matches</div>
                      ) : (
                        searchResults.map((c) => {
                          const alreadyLoaded = loadedCollections.some((lc) => lc.ownerSlug === c.ownerSlug && lc.slug === c.slug);
                          return (
                            <div
                              key={`${c.ownerSlug}/${c.slug}`}
                              className={`flex items-stretch text-xs font-mono ${alreadyLoaded ? 'opacity-40' : ''}`}
                            >
                              <button
                                onClick={() => { loadCollection(c); }}
                                disabled={loading || alreadyLoaded}
                                className="flex-1 min-w-0 text-left px-2 py-1 hover:bg-parchment-dark disabled:cursor-not-allowed"
                              >
                                <div className="font-medium truncate">
                                  {!c.public && <Lock size={10} className="inline-block mr-1 text-ink-muted" />}
                                  {c.ownerSlug}/{c.slug}
                                </div>
                                <div className="text-ink-muted truncate">
                                  {c.recordCount}r{c.name && c.name !== c.slug ? ` · ${c.name}` : ''}
                                </div>
                              </button>
                              <button
                                onClick={() => setSelectedForVersion(c)}
                                disabled={loading || alreadyLoaded}
                                className="shrink-0 w-16 flex items-center justify-center border-l border-rule text-ink-muted hover:bg-parchment-dark hover:text-ink disabled:cursor-not-allowed text-[11px]"
                                title="Choose specific version"
                              >
                                {c.latestSemver ?? `v${c.latestVersion}`}
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-mono font-medium">{selectedForVersion.ownerSlug}/{selectedForVersion.slug}</span>
                    <button
                      onClick={() => setSelectedForVersion(null)}
                      className="text-[11px] text-ink-muted hover:text-ink font-mono"
                    >
                      ← back
                    </button>
                  </div>
                  <div className="text-[10px] text-ink-muted font-mono mb-1">Select version:</div>
                  <div className="max-h-40 overflow-y-auto space-y-0.5">
                    {availableVersions.length === 0 ? (
                      <div className="text-xs text-ink-muted px-2 py-1 font-mono">Loading versions...</div>
                    ) : (
                      availableVersions.map((v) => {
                        const alreadyLoaded = loadedCollections.some(
                          (lc) => lc.ownerSlug === selectedForVersion.ownerSlug && lc.slug === selectedForVersion.slug && lc.version === v.number,
                        );
                        return (
                          <button
                            key={v.number}
                            onClick={() => {
                              loadCollection(selectedForVersion, v.number, v.semver);
                              setSelectedForVersion(null);
                            }}
                            disabled={loading || alreadyLoaded}
                            className="w-full text-left px-2 py-1 text-xs hover:bg-parchment-dark disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                          >
                            <span className="font-medium">{v.semver}</span>
                            <span className="text-ink-muted ml-1">({v.recordCount}r)</span>
                            {v.message && <span className="text-ink-muted ml-1">— {v.message}</span>}
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Loading indicator */}
          {loading && (
            <div className="text-[11px] font-mono text-ink-muted animate-pulse mb-2">{loadingMessage}</div>
          )}

          {/* SQL / natural language input */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (input.trim() && !isRunning) handleSubmit(input);
              }
            }}
            placeholder={
              loadedCollections.length === 0
                ? "Add a collection to start querying..."
                : "SELECT * FROM ... "
            }
            disabled={loadedCollections.length === 0 || isRunning}
            className="w-full bg-parchment border border-rule px-2.5 py-2 text-sm font-mono placeholder:text-ink-muted focus:outline-none focus:border-ink resize-none disabled:opacity-50"
            rows={3}
          />
          {isRunning && (
            <div className="text-[11px] font-mono text-ink-muted mt-1 animate-pulse">Generating query...</div>
          )}
        </div>

        {/* History */}
        <div className="flex-1 overflow-y-auto">
          {history.length > 0 && (
            <div className="px-3 pt-2 pb-1 flex items-center justify-between">
              <span className="text-[10px] font-mono text-ink-muted uppercase tracking-wide">History</span>
              <button
                onClick={clearHistory}
                className="text-[10px] font-mono text-ink-muted hover:text-red-700"
              >
                Clear
              </button>
            </div>
          )}
          {history.length === 0 && (
            <div className="p-3 text-xs text-ink-muted">
              {sqlJsError ? (
                <span className="text-red-700">{sqlJsError}</span>
              ) : !sqlJsReady ? (
                "Loading SQL engine..."
              ) : loadedCollections.length === 0 ? (
                "Add a collection above, then type a SQL query."
              ) : (
                "Type a query and press Enter. Results appear on the right."
              )}
            </div>
          )}
          {history.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSelectedEntry(entry)}
              className={`w-full text-left px-3 py-2.5 border-b border-rule hover:bg-parchment-dark transition-colors ${
                selectedEntry?.id === entry.id ? "bg-parchment-dark" : ""
              }`}
            >
              {/* Prompt (if LLM-generated) */}
              {entry.prompt && (
                <div className="text-[11px] text-ink-muted mb-0.5 truncate italic">
                  "{entry.prompt}"
                </div>
              )}
              {/* SQL */}
              <div className="text-xs font-mono text-ink truncate">
                {entry.sql || <span className="text-red-700">Failed</span>}
              </div>
              {/* Meta line */}
              <div className="text-[10px] text-ink-muted mt-0.5 flex items-center gap-2">
                <span>{entry.collections.join(", ")}</span>
                {entry.result && (
                  <span>· {entry.result.rows.length} rows</span>
                )}
                {entry.error && (
                  <span className="text-red-700">· error</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right panel: results */}
      <div className="flex-1 flex flex-col overflow-hidden bg-parchment min-h-0">
        {isRunning && !selectedEntry ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-ink-muted font-mono animate-pulse">Generating query...</p>
          </div>
        ) : !selectedEntry ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-ink-muted font-mono">Results will appear here</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
            {/* Result header: full context */}
            <div className="px-4 py-3 border-b border-rule space-y-2">
              {/* Collections row */}
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-mono text-ink-muted truncate min-w-0">
                  {selectedEntry.collections.join(" · ")}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {selectedEntry.durationMs !== undefined && (
                    <span className="text-[11px] font-mono text-ink-muted">
                      {selectedEntry.durationMs >= 1000
                        ? `${(selectedEntry.durationMs / 1000).toFixed(1)}s`
                        : `${selectedEntry.durationMs}ms`}
                    </span>
                  )}
                  {selectedEntry.result && (
                    <span className="text-[11px] font-mono text-ink-muted">
                      {selectedEntry.result.rows.length} row{selectedEntry.result.rows.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {selectedEntry.result && selectedEntry.result.rows.length > 0 && (
                    <button
                      onClick={() => downloadCsv(selectedEntry.result!, `query-${selectedEntry.id}.csv`)}
                      className="text-[11px] font-mono border border-rule px-2 py-0.5 hover:bg-parchment-dark text-ink-muted hover:text-ink"
                    >
                      ↓ CSV
                    </button>
                  )}
                </div>
              </div>

              {/* Prompt (if LLM-generated) */}
              {selectedEntry.prompt && (
                <div className="text-xs text-ink-muted italic">
                  "{selectedEntry.prompt}"
                </div>
              )}

              {/* Full SQL */}
              {selectedEntry.sql && (
                <pre className="text-xs font-mono bg-parchment-dark border border-rule px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words">
                  {selectedEntry.sql}
                </pre>
              )}

              {/* LLM reasoning */}
              {selectedEntry.reasoning && (
                <div className="text-[11px] text-ink-muted border-l-2 border-rule pl-2">
                  {selectedEntry.reasoning}
                </div>
              )}
            </div>

            {/* Error display */}
            {selectedEntry.error && (
              <div className="px-4 py-3 bg-red-50 border-b border-red-200 text-sm text-red-800 font-mono">
                {selectedEntry.error}
              </div>
            )}

            {/* Raw LLM response for debugging */}
            {selectedEntry.rawResponse && (
              <div className="px-4 py-3 border-b border-rule">
                <div className="text-[10px] font-mono text-ink-muted uppercase tracking-wide mb-1">Raw LLM Output</div>
                <pre className="text-xs font-mono bg-parchment-dark border border-rule px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words text-ink-light">
                  {selectedEntry.rawResponse}
                </pre>
              </div>
            )}

            {/* Results table */}
            {selectedEntry.result && selectedEntry.result.columns.length > 0 && (
              <div className="px-4 py-3">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="border-b border-rule">
                      {selectedEntry.result.columns.map((col, i) => (
                        <th key={i} className="text-left px-2 py-1.5 font-medium text-ink-light sticky top-0 bg-parchment">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedEntry.result.rows.slice(0, 500).map((row, i) => (
                      <tr key={i} className="border-b border-rule last:border-0 hover:bg-parchment-dark">
                        {row.map((cell, j) => (
                          <td key={j} className="px-2 py-1 max-w-xs truncate">
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
                  <div className="text-[11px] text-ink-muted mt-2 font-mono">
                    Showing 500 of {selectedEntry.result.rows.length} rows. Download CSV for full results.
                  </div>
                )}
              </div>
            )}

            {selectedEntry.result && selectedEntry.result.columns.length === 0 && !selectedEntry.error && (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-ink-muted font-mono">Query returned no results.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
