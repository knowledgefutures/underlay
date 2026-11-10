# Underlay protocol, version 3 (draft)

**Status:** Draft, 2026-11-10. Not stable. Implemented in `packages/protocol/src/v3/`. Where this
document and the code disagree while both are drafts, fix whichever is wrong and say so in the
commit.

Version 3 defines four things: the **sorted-record-file**, the **commit**, the **layout file**,
and the **collection** that holds them. It does not define how a server keeps those objects,
when it rebuilds, whether it stores identical files once, who may read, or how it bills. Those
are choices of each server (Section 9 gives the reference server's).

Records, canonical JSON, input rules, key order, and schemas are those of version 2
(`docs/protocol-v2.md` Sections 2 to 5 and 7) unless changed here.

## 1. Terms

- **Record:** an id, a type, and data. Its **key** is (type, id).
- **Key order:** by type, then by id, each compared as UTF-8 bytes (v2 Section 7).
- **Sorted-record-file:** an immutable file of record lines in key order with a table of
  contents, named by its **file id**.
- **Commit:** a numbered object naming the sorted-record-files one upload added.
- **Version:** the commits of a collection up to and including one commit.
- **Rebuild:** writing new sorted-record-files that hold the rows of older ones.
- **Layout file:** a numbered object, written by a rebuild, listing the sorted-record-files that
  hold everything through a commit.
- **Asset:** a byte string named by its SHA-256.

## 2. Lines

A sorted-record-file holds two kinds of line. Each is UTF-8 and ends with `\n`.

- **Record line:** the canonical form of a record (v2 Section 4):
  `{"id":` JCS(id) `,"type":` JCS(type) `,"data":` JCS(data) `}`.
- **Removal line:** `{"id":` JCS(id) `,"removed":true,"type":` JCS(type) `}`. It says the record
  with that key is removed.

The **size** of a line is its length in bytes without the `\n`. The **hash** of a record line is
the SHA-256 of those bytes, in lowercase hex (v2's record hash). A removal line has no hash.

Reserved types begin with `$`:

| Type      | Id                      | Data                                       |
| --------- | ----------------------- | ------------------------------------------ |
| `$schema` | a type name             | that type's JSON Schema (v2 Section 5)     |
| `$asset`  | an asset's SHA-256, hex | `{"size": n, "mediaType": string or null}` |
| `$meta`   | `collection`            | the collection's metadata object           |

A publisher's own types MUST NOT begin with `$`, and no other `$` type is valid.

## 3. Sorted-record-file

```
[record block]… [key block]… [footer] [trailer]
```

Every block and the footer is one gzip member (RFC 1952). A reader MUST accept any valid gzip
member. Nothing that is hashed depends on compressed bytes.

### 3.1 Record blocks

The file's lines, in order, cut into blocks. A block closes after the first line that brings its
uncompressed size (lines and their `\n`) to 262,144 bytes or more. The last block closes at the
last line. A file with no lines has no record blocks.

### 3.2 Entries

Each line has one or more **entries**. An entry is a JSON array:

```
[kind, type, id, hash, size, block, offset]            in a file from an upload
[kind, type, id, hash, size, block, offset, commit]    in a rebuilt file
```

- `kind` is `"r"` for a record line, `"x"` for a removal line, and `"w"` for a record whose
  line is withheld (a takedown, Section 7).
- `hash` is the line's hash, or `null` for a removal.
- `size` is the line's size.
- `block` is the number of the record block holding the line, from 0. `offset` is the byte
  offset of the line within that block's uncompressed bytes. Both are `null` for `"w"`, which
  has no line in the file.
- `commit` is the number of the commit that wrote the row.

A file is **labeled** if its entries carry `commit`, and **unlabeled** otherwise. All entries of
a file are one or the other. `"w"` entries appear only in labeled files.

Order of entries: by key; in a labeled file, entries with the same key are in ascending `commit`
order, and no two have the same `commit`. In an unlabeled file keys are unique.

Lines are in the order of their first entry. In a labeled file, consecutive entries with the
same key, the same `kind`, and the same `hash` (a row rewritten unchanged) share one line: they
have the same `block`, `offset`, and `size`. No other entries share a line. Sharing is a rule,
not a choice, so that the entries alone decide the lines.

A file holds at most 1,048,576 entries.

### 3.3 Key blocks

The entries, in order, cut into blocks of 1,024 entries; the last block holds the rest. A key
block's uncompressed bytes are its entries, each as JCS followed by `\n`.

### 3.4 Footer

The footer's uncompressed bytes are the JCS of:

```
{"content": {
   "underlay": 3,
   "labeled": boolean,
   "entries": n, "lines": n, "records": n, "removals": n, "withheld": n,
   "bytes": total uncompressed size of the record blocks,
   "first": [type, id] | null, "last": [type, id] | null,
   "commits": [lowest, highest] | null,
   "keyBlocks": [[type, id, hash, entries], …]
 },
 "locator": {
   "recordBlocks": [compressed length, …],
   "keyBlocks": [compressed length, …]
 }}
```

- `keyBlocks` lists, for each key block, the key of its first entry, the SHA-256 of its
  uncompressed bytes, and its number of entries.
- `records`, `removals`, and `withheld` count entries of each kind. `lines` counts lines.
- `first` and `last` are the keys of the first and last entries, `null` in an empty file.
- `commits` is `null` in an unlabeled file.
- The locator gives each block's compressed length in file order. Record blocks start at byte
  0; key blocks follow them; the footer follows the key blocks.

**File id** = SHA-256, in lowercase hex, of JCS(`content`).

### 3.5 Trailer

The last 16 bytes of the file: the 8 bytes `55 4C 33 53 52 46 0A 00` (`UL3SRF\n\0`), then the
footer's compressed length as an unsigned 64-bit big-endian integer.

### 3.6 Determinism

The same lines and entries produce the same `content`, and so the same file id, whatever
compressor, compression level, or write buffering is used. A writer has no choices that reach
`content`.

### 3.7 Validity

A file is valid if and only if:

- the trailer and footer parse, and the footer is the JCS of an object with exactly these
  members; it has at most 1,048,576 entries;
- each key block's uncompressed bytes hash to the listed hash, hold the listed number of
  entries, and its first entry has the listed key; every key block but the last has 1,024
  entries;
- entries are in order (3.2), each is canonical JSON, with valid type and id (v2 Section 3);
- each entry's line, read at (`block`, `offset`, `size`), is followed by `\n`; for `"r"` it
  hashes to `hash` and is the canonical form of a record with the entry's id and type; for `"x"`
  it is exactly the removal line for the entry's key; a `"w"` entry has no line;
- lines fill each record block exactly, in entry order, shared as 3.2 says, and blocks are cut
  by 3.1;
- the counts, `bytes`, `first`, `last`, `commits`, and `labeled` match the entries.

A reader that does not trust where a file came from MUST check what it reads: the footer
against the file id, a key block against the footer, a line against its entry.

## 4. Commit

A commit is the JCS of:

```
{"underlay": 3,
 "collection": collection id,
 "number": n,                       1 for the first commit
 "previous": version id | null,     of commit n − 1
 "semver": "v1.0.0",
 "createdAt": ISO 8601 UTC,
 "changes": [{"collection": collection id,
              "files": [{"id", "first", "last", "entries", "records", "removals", "bytes"}, …],
              "base": version id | null,
              "message": string | null,
              "keyId": string | null, "sig": string | null}, …],
 "keyId": string | null, "sig": string | null}
```

A commit has two parts. A **change** is what an author sent: the files of one upload, the
version they were working from, and a message. The rest is what the server adds when the change
lands: its number, the commit before it, the semver, and the time.

- **Version id** = `ulv3:` + SHA-256 hex of the commit's bytes.
- The files a commit names are unlabeled. Within one commit their key ranges MUST NOT overlap.
  Every row in them counts as written by this commit.
- A commit with number `n` exists only once. A writer creates it only if no commit `n` exists,
  and only if commit `n − 1` exists and has version id `previous`.
- `first` and `last` are each file's first and last keys, and `bytes` its footer's `bytes`.
  With them the commit's rows can be cut into the same files again (Section 7).
- A change's `collection` is the commit's.
- `changes` is a list so that one commit can later carry several authors' uploads. A writer
  today makes one change per commit.

### 4.1 Base

`base` is the version id the author was working from when they prepared the upload, or `null`.
The author sets it; the server sets `previous`. The two are equal unless another commit landed
in between.

- The server records `base` as given. It MUST refuse a base that is not the version id of an
  earlier commit in this collection's log (which, for a fork, includes the commits of the
  collections it was forked from).
- Nothing else depends on it. A commit is never refused because of its base, and reading is
  unchanged: the newest entry wins (Section 6).
- What it gives: for any commit, the keys it wrote that other commits changed after its base
  and up to its `previous` can be listed from key entries alone. Those are the changes the
  author had not seen.

### 4.2 Signatures

Both signatures are Ed25519 over the JCS of the signed object without its `sig` member, base64url
without padding, as v2 Section 11.1. `keyId` is the first 16 hex characters of the SHA-256 of
the raw public key. `keyId` and `sig` are both `null`, or neither is.

- **The author signs the change:** its `collection`, `files`, `base`, `message`, and `keyId`.
  The signature does not cover the commit's `number` or `previous`.
- **The server signs the commit:** every member but its own `sig`, the changes and their
  signatures included.
- A change that loses the race for a number is committed at the next free number with the
  author's signature unchanged. Only the server's part is made again.
- Which keys a reader trusts, for either signature, is not part of this protocol.

### 4.3 Naming a file

A server MUST NOT accept a change that names a file unless the file's bytes came with that
upload and check out against the file id (3.7). That a file with the id is already stored is
never enough: otherwise knowing an id would be a way to test whether a file exists, and then to
read it through a collection of one's own. The one exception is the server's own copy of
commits from a collection the caller may read, which is how a fork begins (Section 8).

### 4.4 Semver

As v2 Section 10.1, from what the commit changes relative to the version before it:

1. The first commit is `v1.0.0`.
2. If it adds, removes, or changes a `$schema` row: major.
3. Otherwise, if it adds, removes, or changes a row of any non-reserved type: minor.
4. Otherwise: patch.

A `$schema` row equal to the row it would replace (same key, same hash; or a removal of an
absent key) is not a change, so a committer always compares schema rows with the version
before. For other rows a committer MAY make the same comparison, and otherwise counts every row
as a change. The comparison costs a lookup per row, and nothing else about a commit reads the
collection. A commit that changes nothing SHOULD NOT be made.

### 4.5 Schemas

A record of a publisher's type `T` in a version MUST satisfy the `$schema` row for `T` in that
version. A type with records MUST have a `$schema` row. When a commit changes a schema, every
record of that type the version carries over MUST satisfy the new schema, and the commit MUST
be refused if any does not. A change that only relaxes the schema (every document valid before
is valid after) needs no check of the records carried over.

## 5. Layout file

The JCS of:

```
{"underlay": 3, "collection": collection id, "number": n, "through": commit number,
 "createdAt": ISO 8601 UTC,
 "files": [{"id", "labeled", "first", "last", "commits": [lowest, highest],
            "entries", "records", "removals", "bytes"}, …]}
```

- The files together hold every row written by commits 1 to `through` that some retained
  version can see. Which versions are retained is the server's choice. A layout that no longer
  holds every version states which it holds in `retained`: a list of `[lowest, highest]` ranges
  of commit numbers, in order. Without it every version is retained.
- A labeled file's `commits` is its footer's. An unlabeled file in a layout has `commits`
  `[c, c]`: all its rows count as written by `c`.
- A layout MAY carry other members for the server's own use, on itself or on a file. A reader
  ignores those it does not know.
- A layout with number `n` exists only once, and is created only if absent. The layout with the
  highest number is current. Each layout is complete; earlier ones are not needed.

## 6. Reading a version

To read version `v` of a collection:

1. Let `L` be the current layout, or none. The files are `L`'s files plus the files named by
   commits `L.through + 1` to `v` (all commits 1 to `v` if there is no layout).
2. For a key, among the entries of those files whose commit is at most `v`, the entry with the
   highest commit wins. If it is a removal, or there is none, the version has no record with
   that key. If it is withheld, the version has a record with that key and hash whose line the
   server no longer holds. Otherwise the record is the entry's line.

If `v` is at or below `L.through` and `L` does not retain it, the read fails.

The changes between versions `a` and `b` (`a` < `b`) are the keys with an entry whose commit is
above `a` and at most `b`. A file whose `commits` range lies outside that is not read.

## 7. Rebuild

A rebuild takes files the current layout or later commits name, and writes labeled files that
hold their rows, then creates the next layout. A layout MAY also list a commit's files as they
are. A rebuild MUST preserve every retained version: each reads the same before and after.

- **Thinning.** An entry with commit `c` is seen by versions `c` up to, but not including, the
  commit of the next entry for its key. A rebuild MAY drop an entry that no retained version
  sees. It MAY drop a removal that would then be the oldest entry for its key only if the
  removal's commit is before the oldest retained version, and no file it leaves out can hold an
  older entry for that key.
- **Takedown.** A rebuild MAY replace a record entry by a `"w"` entry with the same hash, size,
  and commit, and leave out its line. Every file holding the row has to be rebuilt for the
  bytes to be gone.

Because of 3.6, the files a commit named can be recreated from rebuilt files that still hold
all of the commit's rows: take the entries labeled with its number, in key order, drop the
labels, cut them at the `first` keys the commit recorded, and write each part by Section 3. The
results have the ids the commit recorded. A commit with a row that was thinned or withheld
cannot be recreated in full.

## 8. Collection

A collection is:

- a description: a JSON object with at least `id`; for a fork, where it was forked from
  (`forkedFrom`: collection id, commit number, version id) and its `lineage`: the collections
  whose ids its earlier commits carry, oldest first, each with the last commit number that
  carries it;
- its commits, numbered from 1 with no gaps;
- its layouts;
- the sorted-record-files and assets those name.

A collection names files and assets by id only. It never refers to another collection's
commits or layouts. A fork begins as a copy of another collection's commits up to the fork
point, and of its current layout; those commits carry the ids of the collections they were
made in and are valid under `lineage`. The fork point is at or after the copied layout's
`through`, since labeled files may hold rows of every commit up to it.

## 9. The reference server's storage (informative)

```
uploads/<session>/<file id>       an upload's files, until its commit checks and installs them
records/<file id>                 sorted-record-files, shared by every collection naming them
assets/<sha256>                   assets, shared the same way
collections/<id>/collection.json
collections/<id>/commits/<number, 16 digits>.json
collections/<id>/layouts/<number, 16 digits>.json
collections/<id>/latest.json          a hint to the newest commit, may be stale
collections/<id>/latest-layout.json   a hint to the newest layout, may be stale
tmp/                              files being written, before their id is known
trash/records/, trash/assets/     objects the sweep removed, kept for a while
sweep/                            the sweep's own state
```

- Commits and layouts are created with a put that fails if the key exists. Nothing else decides
  a race.
- `latest.json` is `{"commit": n}`, overwritten after each commit; `latest-layout.json` is
  `{"layout": m}`, overwritten after each layout. Two objects, so each has one writer and no
  key is written twice when a layout follows a commit. A reader starts from them and probes
  upward; without them, a reader probes from 1. A failed write of either is ignored.
- A file or asset is stored once. An upload always sends its bytes, into its own session; the
  commit checks them there (4.3) and installs them among the stored files. A file already
  stored under that id is left as it is, and the uploader is not told.
- **Rebuild policy.** Each layout file carries `run`, a number shared by the files one merge
  wrote (0 for a commit's own file, whose run is its commit). Runs are kept in commit order,
  and cover commit ranges that don't overlap. Size tiers are a factor of 10 apart. For each
  tier, lowest first: where 10 or more neighbouring runs are each at or below it, and together
  are at least twice the largest of them, they are merged into files cut at 1 GiB of lines, at
  262,144 entries, and where the type changes once a file holds 16 MiB. Replaced rows stay in
  the same file as the rows that replaced them.
- **Cutting by key, and keeping what did not change** (built, not yet the default; to be
  measured). A file can also end after a key picked by a hash of the key against its row's size,
  toward a target stored size. The same stretch of keys then lands in the same file with
  the same id, whoever builds it. And a merge can leave as it is any file whose key range no
  other file has an entry in: nothing changed there. The target size, the cut keys, and when
  to merge this way are the server's choice; the protocol says nothing about how large a
  sorted-record-file is or where it is cut.
- **Sweep.** A file is listed if a collection's current layout, or a commit after that
  layout's `through`, names it. An asset is listed if a `$asset` entry in a listed file names
  it. One sweeper runs in passes. A pass condemns what nothing lists; moves to `trash/` what is
  still unlisted and has been condemned longer than a grace period; moves back anything in
  `trash/` that is listed again; and deletes from `trash/` what has been there longer than a
  second period. An object's age alone is never the test, since a fork can copy a layout just
  before its parent's next layout drops a file. The sweep's only state is a ledger of what it
  has condemned and trashed, written whole by each pass under the pass's number, so nothing is
  overwritten.

## 10. Constants

| Name                 | Value             |
| -------------------- | ----------------- |
| `RECORD_BLOCK_BYTES` | 262,144           |
| `KEY_BLOCK_ENTRIES`  | 1,024             |
| `MAX_FILE_ENTRIES`   | 1,048,576         |
| Trailer magic        | `UL3SRF\n\0`      |
| Version id prefix    | `ulv3:`           |
| Number width in keys | 16 decimal digits |

Limits on ids, types, record size, depth, and schemas are v2's (Section 12).
