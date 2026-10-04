# @underlay/cli

The Underlay v2 command line. Source is in `src/`; `pnpm --filter @underlay/cli build` bundles it
to `dist/cli.js`. Unpublished.

A working directory holds a local repository in `.underlay/`: a repository in the protocol layout
(`repo/`), local versions, staging and remotes (`src/local.ts`). Versions are built with
`buildVersion` from `@underlay/protocol`, the registry's own commit engine, so pushing a version
gives the registry the same trees.

```
underlay init | clone <url> <owner/slug> [dir] [--token]
underlay schema-set <file>        stage the type set ({type: schema})
underlay add <file>               stage records (NDJSON {id, type, data, private?})
underlay rm <type> <ids…>         stage deletes
underlay meta-set <file> | --clear
underlay file add <paths…>        store files records reference ({"$file":"sha256:…"})
underlay commit -m <message>
underlay status | log | diff <from> <to>
underlay remote add <name> <url> -c <owner/slug> [-t <token>] | remove | list
underlay pull [remote] [--force]
underlay push [remote]
```

- **pull** verifies the registry's signed log after what was last seen, then receives the newest
  version as a pack against the last synced one; every tree is re-derived before it's accepted.
  With a token it fetches the private sets the token can read.
- **push** sends the local changes since the last sync as a delta push (upserts with their set,
  and deletes), uploads the files they need, and then requires the registry's new version to be
  the local one: the same hash, or, when the registry's private salt differs from a new local
  repository's, the same records, files and metadata, checked by pulling it back.
- **Privacy** is carried: `private: true` on a record puts it in the private set locally and on
  the registry, and private types (`"private": true` in the schema) are private throughout.

Before publishing: the npm name `@underlay/cli` belongs to a 2023 package from the earlier
Underlay project, so publishing needs that account, a version above `0.0.1`, or another name.
