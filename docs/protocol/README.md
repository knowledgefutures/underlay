# The Underlay protocol

**Current: [version 3](v3.md)** (`"underlay": 3` in every object it defines).

Each version of the protocol is one file here, `v<N>.md`, and keeps that name for good. While a
version is current its file is where it changes, under its own change control; a new version
starts as a new file, and the one before it stops changing. Cite a section by its version's
file, `docs/protocol/v3.md` 7.2, so a citation never points at another version's numbering. A
test checks that every such citation names a section that exists
(`packages/protocol/test/protocol-refs.test.ts`).

| Version | File           | Status                                                                                   |
| ------- | -------------- | ---------------------------------------------------------------------------------------- |
| 3       | [v3.md](v3.md) | Current, draft. Every collection on underlay.org is held in it.                          |
| 2       | [v2.md](v2.md) | Frozen 2026-10-03. History: underlay.org's collections moved to version 3 on 2026-11-13. |

On the site, `/docs/protocol` leads to the current version's pages, `/docs/protocol/v3/…`.
