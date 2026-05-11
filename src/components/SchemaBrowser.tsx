import { Link } from 'react-router'
import { useState, useEffect, useRef } from "react";

interface SchemaResult {
  id: string;
  schema: Record<string, unknown>;
  schemaHash: string;
  createdAt: string;
  labels: string[];
}

export default function SchemaBrowser() {
  const [query, setQuery] = useState("");
  const [filterType, setFilterType] = useState<"q" | "label" | "slug">("q");
  const [schemas, setSchemas] = useState<SchemaResult[]>([]);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function load(q = "", type = filterType) {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set(type, q);
    params.set("limit", "50");
    try {
      const res = await fetch(`/api/schemas?${params}`);
      const data = await res.json();
      setSchemas(Array.isArray(data) ? data : data.id ? [data] : []);
    } catch {
      setSchemas([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function handleInput(value: string) {
    setQuery(value);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => load(value, filterType), 300);
  }

  function handleFilterChange(type: "q" | "label" | "slug") {
    setFilterType(type);
    if (query) {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => load(query, type), 100);
    }
  }

  return (
    <>
      <div className="flex gap-2 mb-6">
        <input
          type="search"
          placeholder={
            filterType === "q"
              ? "Search schema content..."
              : filterType === "label"
                ? "Search by label..."
                : "Search by type name..."
          }
          className="flex-1 bg-parchment border border-rule px-3 py-2 text-sm font-mono placeholder:text-ink-muted focus:outline-none focus:border-ink"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
        />
        <div className="flex border border-rule rounded overflow-hidden text-xs">
          <button
            onClick={() => handleFilterChange("q")}
            className={`px-3 py-2 transition-colors ${filterType === "q" ? "bg-ink text-parchment" : "hover:bg-parchment-dark"}`}
          >
            Content
          </button>
          <button
            onClick={() => handleFilterChange("slug")}
            className={`px-3 py-2 border-l border-rule transition-colors ${filterType === "slug" ? "bg-ink text-parchment" : "hover:bg-parchment-dark"}`}
          >
            Type
          </button>
          <button
            onClick={() => handleFilterChange("label")}
            className={`px-3 py-2 border-l border-rule transition-colors ${filterType === "label" ? "bg-ink text-parchment" : "hover:bg-parchment-dark"}`}
          >
            Label
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {loading ? (
          <p className="text-sm text-ink-muted py-8 text-center">Loading...</p>
        ) : schemas.length === 0 ? (
          <p className="text-sm text-ink-muted py-8 text-center">No schemas found.</p>
        ) : (
          schemas.map((s) => {
            const properties = (s.schema as any)?.properties ?? {};
            const fieldNames = Object.keys(properties);
            const isPrivate = (s.schema as any)?.private === true;

            return (
              <Link
                key={s.id}
                to={`/schemas/${s.id}`}
                className="block border border-rule p-4 hover:bg-parchment-dark/50 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-xs text-ink-muted">
                      {s.schemaHash.slice(0, 12)}…
                    </code>
                    {isPrivate && (
                      <span className="text-[11px] border border-rule px-1.5 py-0.5 text-ink-muted">
                        private
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-ink-muted">
                    {new Date(s.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </div>

                {/* Field summary */}
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {fieldNames.slice(0, 8).map((name) => (
                    <span
                      key={name}
                      className="text-[11px] font-mono bg-parchment-dark border border-rule px-1.5 py-0.5 rounded"
                    >
                      {name}
                    </span>
                  ))}
                  {fieldNames.length > 8 && (
                    <span className="text-[11px] text-ink-muted px-1.5 py-0.5">
                      +{fieldNames.length - 8} more
                    </span>
                  )}
                </div>

                {/* Labels */}
                {s.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {s.labels.map((label) => (
                      <span
                        key={label}
                        className="text-[11px] text-link bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
            );
          })
        )}
      </div>
    </>
  );
}
