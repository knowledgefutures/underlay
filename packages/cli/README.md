# @underlay/cli: the Underlay CLI

One program, `underlay`, for collections on your machine: commands, a terminal UI (plain
`underlay` in a terminal), and later `underlay serve`. Design: `_meta/planning/kf/underlay/local-tool.md`;
build plan: `local-tool-build.md` beside it.

**Install:** `curl -fsSL https://underlay.org/cli/install.sh | sh` (or staging's, for staging's
build). It downloads the bundled CLI (one file, Node.js 22.6 or later) from the site it is served
by, checks its SHA-256, and puts `underlay` in `~/.local/bin`. The site serves it because the web
build copies it there (`packages/web/scripts/cli-assets.ts`); the script is
`packages/server/src/api/cli.ts`; the docs are `/docs/cli` (`packages/web/src/routes/docs/cli/`). Not on npm: the name `@underlay/cli`
belongs to an unrelated 2023 package.

From source:

```
pnpm --filter @underlay/cli build
cd packages/cli && pnpm link --global      # puts `underlay` on your PATH
```

Pushing and pulling need the server routes from phase 0 (author-built commits, receipts,
`…/commits`, `…/layout`, `…/record-files/:id`) on the remote.

## Using it

```
underlay init ~/Underlay                  a workspace: underlay.toml, AGENTS.md, folders
underlay login [remote]                   an API key from <remote>/settings/keys, kept in the keychain
underlay ls [remote] [--public [q]]       your orgs' collections (■ ◧ □ here, + not)
underlay add underlay.org/mitp/mit-ai     its folder, schemas and log; its files unless --keep none
underlay new localhost:3000/travis/x      one that isn't on its authority yet; push creates it
underlay status [--json] [--fetch]
underlay run <script> [args] [--detach]   saves a version for each collection it changed
underlay runs [id] [--follow]             history; pause, resume, cancel <id>
underlay log | diff | export <collection>
underlay save <collection> [--from f.ndjson] [-m msg]   schema edits, or records by hand
underlay undo | squash | reword           versions not yet pushed
underlay pull [collections…]              theirs in, yours replayed on top
underlay push [collections…]              asks; public or many removals need `push` typed
underlay add-file <path>                  into inputs/, its shape, the collection it matches
underlay import <file> --collection C --type T [--id col]   the built-in importer, saved as
                                          scripts/imports/<name>.toml and run
underlay read <file> [--sheet S]          rows as NDJSON; underlay eject <import>
underlay config [list|get|set|unset|edit|rule add|rule rm]
```

Scripts: anything executable in `scripts/` (or `.ts`, `.js`, `.py`, `.sh`), declaring what it
writes in a header comment (`// underlay: writes underlay.org/mitp/mit-ai`) or a `.toml` beside
it. It writes NDJSON to `$UNDERLAY_OUT/<authority>/<org>/<name>.ndjson`: the whole collection by
default (`mode additions` for changes only; `types` and `where` to narrow what it is the whole
of). `AGENTS.md` in each workspace says the same for agents.

## Code

- `src/core/`: the library. `config` (the two TOML files, rules), `workspace`, `store` (record
  files and local logs, fetching files from the authority on read), `versions` (save, undo,
  squash, reword, replay), `sync` (pull, push), `scripts`, `runs`, `importers`, `remote` (the
  API, with retries), `handoff`.
- `src/commands/` and `src/cli.ts`: the commands.
- `src/tui/`: the terminal UI (Ink), loaded only when it opens.

Tests (`pnpm --filter @underlay/cli test`) run push and pull against the server's own app
in-process (`test/world.ts`), never a real server.
