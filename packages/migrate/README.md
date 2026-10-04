# @underlay/migrate

v1 (Postgres) → v2 conversion, and the tools around loading the result into a
v2 deployment. Background, decisions and run history: the meta repo's
`planning/kf/underlay/edge-redesign-build.md`, sections "Deployment targets" and
"Fixes after the alignment review".

## Tools

|                             |                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`               | The converter: v1 database → a v2 SQLite file plus repository objects in the target bucket, then (with `V1_S3_*`) copies file bytes to their v2 keys. Its header lists the environment. |
| `src/convert.ts`            | The conversion itself: accounts, then each collection's versions replayed oldest first through `commitVersion`, then collection settings.                                               |
| `src/ssh-psql.ts`           | Reads a v1 database with no reachable port through `ssh … docker exec … psql` (read-only, cursors for ordered reads).                                                                   |
| `src/files.ts`              | Copies v1 file objects to `<repo>/files/<hash>`, hash-checked, re-runnable.                                                                                                             |
| `src/d1-data.ts`            | Writes a SQLite file's rows (or named tables) as SQL for `wrangler d1 execute --file`, parents before children.                                                                         |
| `src/repair.ts`             | Brings an already-loaded deployment up to the current format without converting again: rewrites version logs, records file possession, rebuilds head count trees (`STEPS`).             |
| `scripts/staging-env.sh`    | Environment for dev → staging (decrypts secrets into the shell only).                                                                                                                   |
| `scripts/dev-to-staging.sh` | Runs the converter for dev → staging.                                                                                                                                                   |

## dev → staging

From the repo root, with `sops`, the age key for the env files and `~/.ssh/kf_internal`:

```sh
packages/migrate/scripts/dev-to-staging.sh /tmp/ul-load       # COLLECTIONS=owner/slug,… for some
npx tsx packages/migrate/src/d1-data.ts /tmp/ul-load/migrated.sqlite > /tmp/ul-load/data.sql
cd packages/server
npx wrangler d1 migrations apply underlay-staging --env staging --remote
npx wrangler d1 execute underlay-staging --env staging --remote --file /tmp/ul-load/data.sql
```

Load into an empty D1. Before re-converting collections that are already in the
bucket, delete their `repo/collections/<id>/` objects (logs, head, collection.json);
content-addressed objects can stay. Keep output outside Dropbox: the SQLite file
holds dev's users and sessions.

To repair a loaded deployment, `repair.ts` needs a SQLite copy of its database:
`wrangler d1 export underlay-staging --env staging --remote --output d1.sql`, then
`sqlite3 d1.sqlite < d1.sql`, then `TARGET_DB=file:d1.sqlite TARGET_DB_MIGRATE=0` (the
export already has the schema, without drizzle's bookkeeping) with
`. packages/migrate/scripts/staging-env.sh`. Load the rows it adds with
`d1-data.ts d1.sqlite <table>`.

`STEPS` picks what `repair.ts` does (default `logs,possession`). `STEPS=refs` rebuilds
each collection head's file reference count trees with per-type counts (2026-10-04),
so moving or removing a type stops reading its records; heads whose trees already
have them, or have none, are skipped. It writes `UPDATE versions …` lines to
`REFS_SQL` (default `./refs.sql`); apply them with `wrangler d1 execute … --file`.
Without it nothing breaks: older trees take the slower path.

**Pause storage cleanup first.** These tools write objects to the bucket now and their
rows land in D1 later, outside the write fence, so a sweep in between would delete what
they wrote. On a deployment that has storage cleanup (migration 0015), switch on "Pause
marks and sweeps" at `/admin/cleanup` (or set `cleanup_paused` in `instance_settings`)
before converting or repairing, and switch it off once every row is loaded.

## Tests

`npx vitest run --root packages/migrate`: the converter against v1's own
migrations in PGlite (both read paths), and the file copy.
