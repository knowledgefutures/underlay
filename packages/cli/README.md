# @underlay/cli: the Underlay CLI

One program, `underlay`, for collections on your machine: commands, a terminal UI (plain
`underlay` in a terminal), and later `underlay serve`. Design: `_meta/planning/kf/underlay/local-tool.md`;
build plan: `local-tool-build.md` beside it.

**Install:** `curl -fsSL https://www.underlay.org/cli/install.sh | sh` (or staging's, for staging's
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
underlay init [dir]                       your home (~/Underlay): collections, scripts, inputs, AGENTS.md
underlay sources [add <path>|rm|init]     script folders: shared git repos of scripts
underlay secret set <NAME>                a secret a script folder needs, kept in the keychain (a 0600 file off a Mac)
underlay login [remote]                   an API key from <remote>/settings/keys, kept in the keychain (a 0600 file off a Mac)
underlay ls [remote] [--public [q]]       your orgs' collections (◐ ○ part here, blank all, + not)
underlay add underlay.org/mitp/mit-ai     its folder, schemas, log, records, and files (less with --keep)
underlay new scratch                      one on this machine only: no server, org or sign-in
underlay new underlay.org/mitp/x          one that isn't on its authority yet; push creates it
underlay publish scratch mitp/scratch     a local one to a server; its first push creates it
underlay status [--json] [--fetch]
underlay run <script> [args] [--detach]   saves a version for each collection it changed
underlay view <view>                      a page, or a script that serves one on $PORT
underlay schema <collection> [type]       its schemas as JSON
underlay runs [id] [--follow]             history; pause, resume, cancel <id>
underlay log | diff | export <collection>
underlay save <collection> [--from f.ndjson] [-m msg]   schema edits, or records by hand
underlay undo | squash | reword           versions not yet pushed
underlay pull [collections…]              theirs in, yours replayed on top
underlay push [collections…]              asks; public or many removals need `push` typed
underlay add-file <path>                  into home's inputs/, its shape, the collection it matches
underlay import <file> --collection C --type T [--id col]   the built-in importer, saved as
                                          home's scripts/imports/<name>.toml and run
underlay read <file> [--sheet S]          rows as NDJSON; underlay eject <import>
underlay config [list|get|set|unset|edit|rule add|rule rm]
underlay update                           the newest build from where it was installed (install.sh
                                          writes an `origin` file beside it; checked once a day)
```

Home (`~/Underlay`, or `home` in `~/.config/underlay/config.toml`, or `UNDERLAY_HOME`) is
yours: the collections you follow with their schemas, dropped files, your own scripts. Shared
scripts live in script folders, git repos listed with `underlay sources add` (or the folder you
are in, when it has an `underlay.toml`). See planning's local-tool.md "Home and script folders".

Scripts: files in home's `scripts/` or a script folder that declare themselves in a header
comment (`// underlay: writes underlay.org/mitp/mit-ai`, or `check`, `takes *.xlsx`, `serves`;
`<!-- underlay: view -->` in an `.html` page) or a `.toml` beside them. Files without one are
left alone. A script runs in its folder and writes NDJSON to
`$UNDERLAY_OUT/<authority>/<org>/<name>.ndjson`: the whole collection by default
(`mode additions` for changes only; `types` and `where` to narrow what it is the whole of).
`AGENTS.md` in home says the same for agents.

## Code

- `src/core/`: the library. `config` (config.toml, rules), `home`, `sources` (script folders,
  secrets), `views`, `store` (record
  files and local logs, fetching files from the authority on read), `versions` (save, undo,
  squash, reword, replay), `sync` (pull, push), `scripts`, `runs`, `importers`, `remote` (the
  API, with retries), `handoff`.
- `src/commands/` and `src/cli.ts`: the commands.
- `src/tui/`: the terminal UI (Ink), loaded only when it opens.

Tests (`pnpm --filter @underlay/cli test`) run push and pull against the server's own app
in-process (`test/world.ts`), never a real server.
