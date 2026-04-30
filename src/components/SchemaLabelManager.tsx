import { useState } from "react";

interface Label {
  label: string;
  createdAt: string;
}

interface Props {
  schemaId: string;
  initialLabels: Label[];
}

export default function SchemaLabelManager({ schemaId, initialLabels }: Props) {
  const [labels, setLabels] = useState<Label[]>(initialLabels);
  const [newLabel, setNewLabel] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  async function addLabel(e: React.FormEvent) {
    e.preventDefault();
    if (!newLabel.trim()) return;
    setAdding(true);
    setError("");

    try {
      const res = await fetch(`/api/schemas/${schemaId}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newLabel.trim() }),
      });

      if (res.status === 401) {
        setError("Login required");
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to add label");
        return;
      }

      const data = await res.json();
      if (data.status === "created") {
        setLabels([...labels, { label: newLabel.trim(), createdAt: new Date().toISOString() }]);
      }
      setNewLabel("");
    } catch {
      setError("Network error");
    } finally {
      setAdding(false);
    }
  }

  async function removeLabel(label: string) {
    try {
      const res = await fetch(`/api/schemas/${schemaId}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE",
      });

      if (res.status === 401) {
        setError("Login required");
        return;
      }
      if (res.ok) {
        setLabels(labels.filter((l) => l.label !== label));
        setError("");
      } else {
        const data = await res.json();
        setError(data.error ?? "Failed to remove label");
      }
    } catch {
      setError("Network error");
    }
  }

  return (
    <div className="mb-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">Labels</h2>

      {/* Existing labels */}
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {labels.map((l) => (
            <span
              key={l.label}
              className="inline-flex items-center gap-2 text-sm bg-parchment border border-rule px-3 py-1.5 rounded group"
            >
              <span className="text-ink">{l.label}</span>
              <span className="text-[11px] text-ink-muted">
                {new Date(l.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
              <button
                onClick={() => removeLabel(l.label)}
                className="text-ink-muted hover:text-red-600 transition-colors ml-1 opacity-0 group-hover:opacity-100"
                title="Remove label"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {labels.length === 0 && (
        <p className="text-xs text-ink-muted mb-3">No labels yet.</p>
      )}

      {/* Add label form */}
      <form onSubmit={addLabel} className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Add label (e.g. schema.org/Person)"
          className="bg-parchment border border-rule px-2.5 py-1.5 text-xs font-mono placeholder:text-ink-muted focus:outline-none focus:border-ink w-64"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <button
          type="submit"
          disabled={adding || !newLabel.trim()}
          className="text-xs border border-rule px-2.5 py-1.5 hover:bg-parchment-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {adding ? "Adding..." : "Add"}
        </button>
      </form>

      {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
    </div>
  );
}
