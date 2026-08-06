# @underlay/cli

Source lives in `src/cli`; this package just bundles it (`pnpm --filter @underlay/cli build`).

Currently **unpublished and not built** — runnable only from the repo via `pnpm cli`.

## ⚠️ Review record privacy before publishing this for the first time

The CLI predates per-version record privacy (`version_records.private`, added 2026-08) and
**cannot express it**. Publishing as-is would put a privacy-blind client in users' hands.

Two concrete gaps, both must be closed first:

1. **`src/cli/commands/push.ts` — manifest entries omit `private`.** The manifest is built as
   `{ id, type, hash }`. The server takes each push's manifest as the authoritative statement of
   which records are private, so a push that omits the flag marks every record public. Re-pushing
   a collection that has private records would **silently publish them** in the new version.
2. **`src/cli/commands/add.ts` — `private` is dropped at ingest.** It parses only
   `{ id, type, data }` and stores the canonical hashed object, which by design excludes privacy
   (privacy is contextual, not part of the content hash). So the flag is lost before `push` could
   ever send it. The local store needs somewhere to carry it — e.g. a per-record privacy set in
   the version manifest (`src/cli/lib/store.ts`, `VersionManifest`), kept outside the hash.

Also settle the server-side semantics this depends on before shipping: a manifest entry's
`private` is `z.boolean().optional()`, but ingest currently collapses it (`r.private ?? false`),
so **omitted means public**. If that becomes "omitted means inherit from the base version", the
CLI's obligations change. See `planning/reference-privacy-model.md`.

## Also check before publishing

- **The npm name `@underlay/cli` is already taken** by a 2023 package from the earlier Underlay
  project ("CLI utility for downloading datasets specified in underlay.yaml", maintainers
  `octref`, `joelg@mit.edu`, author "Knowledge Futures Group"). Publishing needs that account, a
  version above `0.0.1`, or a different name.
- The CLI is several releases stale against the API — verify it against the current negotiate
  protocol (chunked manifest, async commit) before shipping.
