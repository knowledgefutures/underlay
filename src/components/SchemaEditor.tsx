import { useState, useEffect } from "react";

interface SchemaRow {
  id: string;
  slug: string;
  schema: Record<string, unknown>;
  schemaHash: string;
  sourceSchemaId: string | null;
  semver: string;
}

interface SuggestionRow {
  id: string;
  slug: string;
  schema: Record<string, unknown>;
  schemaHash: string;
  collectionSlug: string;
  ownerSlug: string;
  semver: string;
}

interface InferResult {
  inferredSchema: Record<string, unknown>;
  schemaHash: string;
  exactMatches: SuggestionRow[];
  compatibleMatches: SuggestionRow[];
}

interface Props {
  owner: string;
  collection: string;
}

export default function SchemaEditor({ owner, collection }: Props) {
  const [currentSchemas, setCurrentSchemas] = useState<SchemaRow[]>([]);
  const [inferred, setInferred] = useState<Record<string, InferResult>>({});
  // slug → { text: string (JSON), sourceSchemaId: string | null }
  const [edits, setEdits] = useState<Record<string, { text: string; sourceSchemaId: string | null }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [activeType, setActiveType] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const allTypes = Array.from(
    new Set([...currentSchemas.map((s) => s.slug), ...Object.keys(inferred)]),
  ).sort();

  useEffect(() => {
    Promise.all([
      fetch(`/api/collections/${owner}/${collection}/schemas`).then((r) => r.json()),
      fetch(`/api/collections/${owner}/${collection}/schemas/infer`, { method: "POST" }).then((r) =>
        r.ok ? r.json() : {},
      ),
    ]).then(([schemas, inf]) => {
      setCurrentSchemas(Array.isArray(schemas) ? schemas : []);
      setInferred(inf ?? {});
      setLoading(false);
    });
  }, [owner, collection]);

  // Initialise edits once data is loaded
  useEffect(() => {
    if (loading) return;
    const initial: typeof edits = {};
    const typeSet = new Set([...currentSchemas.map((s) => s.slug), ...Object.keys(inferred)]);
    for (const slug of typeSet) {
      const current = currentSchemas.find((s) => s.slug === slug);
      const source = current?.schema ?? inferred[slug]?.inferredSchema ?? {};
      initial[slug] = {
        text: JSON.stringify(source, null, 2),
        sourceSchemaId: current?.sourceSchemaId ?? null,
      };
    }
    setEdits(initial);
    if (typeSet.size > 0) setActiveType(Array.from(typeSet).sort()[0]);
  }, [loading]);

  function setEditText(slug: string, text: string) {
    setEdits((prev) => ({ ...prev, [slug]: { ...prev[slug], text } }));
    setErrors((prev) => ({ ...prev, [slug]: "" }));
  }

  function adoptSuggestion(slug: string, suggestion: SuggestionRow) {
    setEdits((prev) => ({
      ...prev,
      [slug]: {
        text: JSON.stringify(suggestion.schema, null, 2),
        sourceSchemaId: suggestion.id,
      },
    }));
    setErrors((prev) => ({ ...prev, [slug]: "" }));
  }

  async function publish() {
    // Validate JSON for each type
    const typeSchemas: Record<string, unknown> = {};
    const schemaSources: Record<string, string> = {};
    const newErrors: Record<string, string> = {};

    for (const [slug, edit] of Object.entries(edits)) {
      try {
        const parsed = JSON.parse(edit.text);
        typeSchemas[slug] = parsed;
        if (edit.sourceSchemaId) schemaSources[slug] = edit.sourceSchemaId;
      } catch {
        newErrors[slug] = "Invalid JSON";
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setPublishing(true);
    setPublishResult(null);

    const body = {
      base_version: null,
      schemas: typeSchemas,
      schema_sources: Object.keys(schemaSources).length > 0 ? schemaSources : undefined,
      changes: {},
    };

    try {
      const res = await fetch(`/api/collections/${owner}/${collection}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setPublishResult({ ok: true, message: `Published ${data.semver} (version ${data.version})` });
      } else if (res.status === 409 && data.existingVersion) {
        setPublishResult({ ok: true, message: "No schema changes detected — schemas are already up to date." });
      } else {
        setPublishResult({ ok: false, message: data.error ?? "Publish failed" });
      }
    } catch (err) {
      setPublishResult({ ok: false, message: "Network error" });
    }
    setPublishing(false);
  }

  if (loading) {
    return <p className="text-sm text-ink-muted py-8 text-center">Loading schemas…</p>;
  }

  if (allTypes.length === 0) {
    return (
      <p className="text-sm text-ink-muted py-8 text-center">
        No record types found. Push a version with records to get started.
      </p>
    );
  }

  const active = activeType ?? allTypes[0];
  const activeSuggestions = inferred[active];
  const activeEdit = edits[active] ?? { text: "{}", sourceSchemaId: null };
  const currentSchema = currentSchemas.find((s) => s.slug === active);
  const isInferred = !currentSchema && !!inferred[active];

  return (
    <div className="flex gap-6 min-h-[600px]">
      {/* Type list */}
      <div className="w-40 shrink-0 border border-rule rounded overflow-hidden self-start">
        {allTypes.map((slug) => {
          const hasError = !!errors[slug];
          return (
            <button
              key={slug}
              onClick={() => setActiveType(slug)}
              className={[
                "w-full text-left px-3 py-2 text-sm border-b border-rule last:border-0 transition-colors",
                slug === active ? "bg-parchment-dark font-medium" : "hover:bg-parchment-dark/50",
                hasError ? "text-red-600" : "",
              ].join(" ")}
            >
              {slug}
              {hasError && <span className="ml-1 text-red-500">!</span>}
            </button>
          );
        })}
      </div>

      {/* Editor + suggestions */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="font-medium text-sm">{active}</span>
            {isInferred && (
              <span className="text-[11px] border border-rule px-1.5 py-0.5 text-ink-muted">imputed from data</span>
            )}
            {activeEdit.sourceSchemaId && (
              <span className="text-[11px] border border-rule px-1.5 py-0.5 text-ink-muted">adopted</span>
            )}
            {activeEdit.sourceSchemaId && (
              <button
                className="text-[11px] text-ink-muted hover:text-ink underline"
                onClick={() =>
                  setEdits((prev) => ({
                    ...prev,
                    [active]: { ...prev[active], sourceSchemaId: null },
                  }))
                }
              >
                clear source
              </button>
            )}
          </div>
          <textarea
            value={activeEdit.text}
            onChange={(e) => setEditText(active, e.target.value)}
            className="w-full h-72 font-mono text-xs border border-rule bg-ink text-parchment p-3 focus:outline-none resize-y"
            spellCheck={false}
          />
          {errors[active] && (
            <p className="text-xs text-red-600 mt-1">{errors[active]}</p>
          )}
        </div>

        {/* Suggestions */}
        {activeSuggestions && (
          <div>
            {activeSuggestions.exactMatches.length > 0 && (
              <div className="mb-3">
                <p className="text-xs font-medium text-ink-muted mb-2">Identical schemas from other collections</p>
                <div className="border border-rule rounded overflow-hidden">
                  {activeSuggestions.exactMatches.map((s, i) => (
                    <div
                      key={s.id}
                      className={`flex items-center justify-between px-3 py-2 ${i < activeSuggestions.exactMatches.length - 1 ? "border-b border-rule" : ""}`}
                    >
                      <div>
                        <span className="text-xs font-medium">{s.slug}</span>
                        <span className="text-xs text-ink-muted ml-2">{s.ownerSlug}/{s.collectionSlug}@{s.semver.split(".")[0]}</span>
                      </div>
                      <button
                        onClick={() => adoptSuggestion(active, s)}
                        className="text-xs text-link hover:underline"
                      >adopt</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeSuggestions.compatibleMatches.length > 0 && (
              <div>
                <p className="text-xs font-medium text-ink-muted mb-2">Compatible schemas (same type name, validates your records)</p>
                <div className="border border-rule rounded overflow-hidden">
                  {activeSuggestions.compatibleMatches.map((s, i) => {
                    const fields = Object.keys((s.schema as any)?.properties ?? {});
                    return (
                      <div
                        key={s.id}
                        className={`flex items-center justify-between px-3 py-2 ${i < activeSuggestions.compatibleMatches.length - 1 ? "border-b border-rule" : ""}`}
                      >
                        <div>
                          <span className="text-xs font-medium">{s.slug}</span>
                          <span className="text-xs text-ink-muted ml-2">{s.ownerSlug}/{s.collectionSlug}@{s.semver.split(".")[0]}</span>
                          {fields.length > 0 && (
                            <span className="text-[11px] text-ink-muted ml-2">{fields.join(", ")}</span>
                          )}
                        </div>
                        <button
                          onClick={() => adoptSuggestion(active, s)}
                          className="text-xs text-link hover:underline"
                        >adopt</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeSuggestions.exactMatches.length === 0 && activeSuggestions.compatibleMatches.length === 0 && (
              <p className="text-xs text-ink-muted">No compatible schemas found from other public collections.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
