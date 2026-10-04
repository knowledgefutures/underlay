# Underlay protocol, format 2

**Status: draft.** Every value marked _provisional_ can still change until the format is frozen.
After the freeze, changing any of them needs a new format number. The reference implementation is
`packages/protocol` (`@underlay/protocol`). The test vectors are in `packages/protocol/test/vectors/v2.json`
(see [Test vectors](#test-vectors)).

This document is normative. Another implementation has to reproduce everything here byte for
byte: it must accept and reject the same inputs, build the same trees, and compute the same hashes.

Design background: the edge redesign plan and its build notes (`planning/kf/underlay/edge-redesign*.md`
in the KF meta repo).

## 1. Conventions

- **hash(x)** is SHA-256 of `x`, written as 64 lowercase hex characters. A string is hashed as its
  UTF-8 bytes.
- **JCS(v)** is the RFC 8785 canonical JSON of a value (section 2).
- **Key order** means comparing the UTF-8 bytes of two strings, which is Unicode code point order
  (section 7). This is _not_ the UTF-16 order that JCS uses to sort object keys.
- Sizes are in bytes. Counts are non-negative integers no larger than 2⁵³ − 1.

## 2. Canonical JSON

Every hashed JSON document is serialized with [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785):

- no whitespace;
- strings escaped as ECMAScript `JSON.stringify` does;
- numbers serialized as ECMAScript `Number.prototype.toString` does, with `-0` written as `0`;
- object members sorted by their keys' UTF-16 code units.

Implementation note for JavaScript: objects enumerate integer-like keys (`"9"`, `"10"`) first, in
numeric order, whatever order they were inserted in. So you can't canonicalize by sorting keys into
a new object and calling `JSON.stringify`. Write objects out as strings instead (see
`packages/protocol/src/jcs.ts`).

## 3. Input rules

These rules apply to every record line and schema a client pushes. The CLI and the server check
them on the **source text**, before or alongside parsing, because a parsed value has already lost
the information they need.

| Rule            | Rejected                                                                                                                                                                                                                                           | Error code         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Duplicate keys  | Two members of one object whose keys are equal after unescaping (`"a"` and `"a"` are duplicates)                                                                                                                                                   | `duplicate_key`    |
| Unsafe integers | An **integer literal** (no fraction, no exponent) whose magnitude exceeds 2⁵³ − 1 (`9007199254740991`). Literals with a fraction or exponent, such as `1e20`, `6.02e23` or `9007199254740993.0`, are accepted and take their IEEE 754 double value | `unsafe_integer`   |
| Lone surrogates | A UTF-16 surrogate code unit, raw or `\u`-escaped, that is not part of a valid pair, in any string or key                                                                                                                                          | `lone_surrogate`   |
| Depth           | Nesting deeper than `MAX_JSON_DEPTH` = 64 levels within `data`. Each object or array is one level, and the record envelope adds one more                                                                                                           | `too_deep`         |
| Record size     | A canonical record (section 4) longer than `MAX_RECORD_BYTES` = 8,388,608 bytes                                                                                                                                                                    | `record_too_large` |
| Record id       | Not a string, empty, or longer than `MAX_ID_BYTES` = 1,024 UTF-8 bytes                                                                                                                                                                             | `bad_id`           |
| Type slug       | Not a string, empty, longer than 128 UTF-8 bytes, starting with `.`, or containing `/`, `\`, U+0000–U+001F or U+007F                                                                                                                               | `bad_type`         |
| Envelope        | A record line that isn't an object with `id`, `type` and `data`, or whose optional `private` isn't a boolean                                                                                                                                       | `bad_envelope`     |
| Syntax          | Anything that isn't JSON (RFC 8259)                                                                                                                                                                                                                | `syntax`           |

Unicode is **not** normalized. `é` as U+00E9 and as U+0065 U+0301 are different ids with different
hashes. The test vectors include both.

The limits are provisional. A sample of production data (206,862 records) found a largest record
of 12 KB and a longest id of 145 bytes.

## 4. Records

A record has an `id` (string), a `type` (type slug) and `data` (any JSON value). Its **canonical
form** is a fixed envelope with only `data` canonicalized:

```
'{"id":' + JCS(id) + ',"type":' + JCS(type) + ',"data":' + JCS(data) + '}'
```

- **Record hash** = hash(canonical form).
- **Record size** = the length in bytes of the canonical form.
- The envelope keeps the field order of format 1, so a record without integer-like keys has the
  same hash in both formats (see [Format 1 hashes](#12-format-1-hashes)).
- Record ids are unique per type within a version, across both access sets (section 9).

**File references.** A record references a file through any object, at any depth of `data`, whose
`$file` member is a string of the form `sha256:` followed by 64 lowercase hex characters. The
referenced file hash is the hex part. A reference object is not searched further for nested
references. A `$file` value of any other form is not a reference, and the object is searched as
usual.

## 5. Schemas

A type's schema is a JSON Schema document. **Schema hash** = hash(JCS(schema)).

- A schema with `"private": true` at its root makes the type private (section 9). A root `private`
  that isn't a boolean is rejected, so that `"private": "true"` can't publish a type by accident.
- `"private": true` on a property, at any depth (field-level privacy), is **rejected** in format 2.
- Limits: the schema's canonical form must be at most 256 KB, and `pattern` values and
  `patternProperties` keys at most 256 characters each.

### 5.1 Validation dialect

**Which schemas are accepted.** A type schema must be a JSON object and a JSON Schema draft-07
document.

- A root `$schema`, if present, must be `http://json-schema.org/draft-07/schema` (with or without a
  trailing `#`); anything else is rejected.
- A schema is rejected unless all of these hold:
  - it is valid against the draft-07 meta-schema;
  - every `pattern` and `patternProperties` key compiles as an ECMAScript regular expression with
    the `u` flag;
  - every `$ref` resolves within the schema or to the draft-07 meta-schema.
- `$ref`s are resolved against the base URI `https://schema.underlay.invalid/` unless a `$id` sets
  another.

**How records are validated.** Draft-07, with these rules:

- Keywords alongside `$ref` are applied, as in draft 2019-09.
- Keywords draft-07 doesn't define are ignored. That includes later drafts' keywords
  (`unevaluatedProperties`, `dependentRequired`, `prefixItems`, …) and draft-04's `id`. `$defs`
  works as a container, and `$anchor` is honoured.
- `pattern` uses ECMAScript regular expressions with the `u` flag.
- `multipleOf` m accepts x when the floating-point remainder r = x mod m satisfies
  |r| < 1.1920929e-7 or |m − r| < 1.1920929e-7.
- String lengths count Unicode code points.
- Object members are the parsed JSON's own keys. Names such as `__proto__` or `toString` carry no
  special meaning.

**Formats.**

- `format` constrains strings only, and only for these names: `date`, `time`, `date-time`,
  `iso-time`, `iso-date-time`, `duration`, `uri`, `uri-reference`, `uri-template`, `url`, `email`,
  `hostname`, `ipv4`, `ipv6`, `regex`, `uuid`, `json-pointer`, `json-pointer-uri-fragment`,
  `relative-json-pointer`, `byte`.
- Each is defined as in ajv-formats 3.0 "full" mode (`packages/protocol/src/validate.ts`). In
  particular:
  - `date-time` and `time` require a time zone;
  - `date-time` accepts `T`, `t` or whitespace as the separator;
  - `email` requires a dot in the domain.
- Other format names are ignored.

**What is normative.** Only the verdict. Error messages, and how many are reported, are not.

The reference validator is `@cfworker/json-schema` with these rules applied
(`packages/protocol/src/validate.ts`). Over all public production data it agrees with format 1's AJV
configuration: 139 schemas, 330,300 records, and 85,773 mutated records
(`scripts/diff-validators.ts`).

## 6. Files

**File hash** = hash(file bytes). A file's size is its length in bytes.

## 7. Key order and boundary hash

- **Key order** compares keys by their UTF-8 bytes, lexicographically, with a shorter prefix
  first. Implementations must not use UTF-16 code-unit comparison (JavaScript's default `<` and
  `sort()`). The two differ when one string has a character at U+10000 or above where the other has
  one in U+E000–U+FFFF.
- **Boundary hash**: u(k) = the first 8 bytes of hash(k), read as a big-endian unsigned 64-bit
  integer.
- **tz(k)** = the number of trailing zero bits of u(k), from 0 to 64.

## 8. Trees

A tree is a sorted set of entries with unique keys, split into nodes. There are two kinds:

| Kind        | Key             | Entry tuple                    | Entry size |
| ----------- | --------------- | ------------------------------ | ---------- |
| Record tree | record id       | `[id, recordHash, recordSize]` | recordSize |
| File tree   | file hash (hex) | `[fileHash, fileSize]`         | fileSize   |

### 8.1 Shape

Parameters (provisional):

| Name                          | Value                         |
| ----------------------------- | ----------------------------- |
| `LEAF_BOUNDARY_BITS`          | 10 (mean leaf: 1,024 entries) |
| `INTERIOR_BOUNDARY_BITS_STEP` | 6 (mean fanout: 64)           |
| `LEAF_MAX_ENTRIES`            | 8,192                         |
| `INTERIOR_MAX_CHILDREN`       | 1,024                         |

- **Leaves (level 0).** Walk the entries in key order. The current leaf ends after entry `k` when
  any of these holds:
  - tz(k) ≥ 10;
  - the leaf now holds `LEAF_MAX_ENTRIES` entries;
  - `k` is the last entry.
- **Interior level i ≥ 1.** Walk the nodes of level i − 1 in order. The current level-i node ends
  after a child `c` when any of these holds:
  - tz(last key of `c`) ≥ 10 + 6i, and 10 + 6i ≤ 64;
  - the node now has `INTERIOR_MAX_CHILDREN` children;
  - `c` is the last node of level i − 1.
- **Root.** Build level after level. The root is the node of the **lowest level that has exactly one
  node**. A tree with one leaf has that leaf as its root. An empty tree has no nodes, and its root is
  `null`.

These rules give the following properties:

- The same entry set always produces the same tree, whatever order it was built in.
- A natural boundary (a key with tz(k) ≥ 10) depends only on the key. A forced split depends only
  on the position since the previous boundary.
- Any range between two natural boundaries can therefore be rebuilt on its own.

### 8.2 Node encoding

```
leaf:      {"e":[entry, entry, ...],"t":"leaf"}
interior:  {"e":[[lastKey, childHash, count, bytes], ...],"l":level,"t":"node"}
```

- Both are JCS documents: no whitespace, members in the order shown.
- `lastKey` is the last key under the child. `count` is the number of entries under it. `bytes` is
  the sum of the entry sizes under it.
- The **node hash** is hash(encoded node).

### 8.3 Validity

A tree is valid exactly when rebuilding its entries under section 8.1 produces the same root hash.
A node received from outside (tree sync, mirrors) must also satisfy all of the following:

- its bytes hash to the expected hash, and are the canonical encoding;
- keys are strictly increasing within the node and across the whole tree;
- every interior entry's `lastKey`, `count` and `bytes` match its child;
- every child is exactly one level below its parent;
- `count` ≥ 1 for every child;
- in a record tree, every key is a valid record id (section 3): not empty, at most `MAX_ID_BYTES`
  UTF-8 bytes, and with no lone surrogate.

A received record leaf must also match its body (section 11). For each entry, its body line (an
out-of-line pointer resolved to its record) must:

- hash to the entry's record hash;
- be exactly the entry's size in bytes;
- be the canonical form (section 4) of a record whose `id` is the entry's key and whose `type` is
  the type of the tree the leaf is in.

A node that hashes correctly but breaks a structural rule is invalid. Accepting one would give two
different roots for one entry set. The reference `fsck` is `verifyTree` in
`packages/protocol/src/tree/verify.ts`.

Record JSON (`{"id",…}`) and node JSON (`{"e",…}`) have disjoint member names, so one can never
be read as the other.

## 9. Access sets

A version has two sets of content: `public` and `private`.

- **Records.** A record pushed with `"private": true` belongs to the private set; any other record
  belongs to the public set. Every record of a private type belongs to the private set.
- **Types.** Each set lists, per type, the schema hash and the tree of that set's records of the
  type.
  - A private type appears only in the private set.
  - A public type appears in the public set, and also in the private set if it has private
    records.
  - A public type with no records still appears in the public set, with a `null` root.
- **Files.** A file belongs to every set that has a record referencing it. A file that is declared
  in the push but referenced by no record belongs to the private set, unless the push marks it
  public.
- **Readers.** Owners may read both sets; everyone else, the public set only. Whether the collection
  itself is public is mutable collection metadata. It is not part of the version.

## 10. Versions

```
SetObject = {
  "types": { slug: { "schema": schemaHash, "root": treeHash|null, "count": n, "bytes": b }, ... },
  "files": { "root": treeHash|null, "count": n, "bytes": b }
}
PrivateSetObject = SetObject + { "salt": 64 hex chars }
root = { "underlay": 2, "metadata": object|null, "public": SetObject, "private": commitment|null }
```

- `count` and `bytes` are the root node's totals, or 0 for a `null` root.
- **Commitment** = hash(JCS(PrivateSetObject)).
- The salt is 32 random bytes, chosen once per collection and reused across its versions. That way
  an unchanged private set keeps its commitment.
- `private` is `null` when the private set is **empty**, meaning it has no types and no files.
- **Version hash** = `"ulv2:"` + hash(JCS(root)).

A version hash commits to content only. There is no parent pointer, so the same content gives the
same hash in any collection (unless it has a private set, whose salt differs). Lineage, semver,
messages and authorship are mutable server state.

What each reader can check:

- Public readers get the root and can verify the version hash and everything in the public set.
  From the root they learn only whether a private set exists.
- Owners also get the private set object, salt included, and can check it against the commitment.

## 11. Repository layout

A repository is how a storage location holds collections. It is the same on the platform's own
bucket, on a customer's mirror and in a restore source. Keys are relative to the location's prefix.
The reference implementation is `packages/protocol/src/repo` (`@underlay/protocol`).

```
nodes/<nodeHash>                          node JSON (section 8.2), gzip-compressed
bodies/<leafHash>.ndjson.gz               a record leaf's records
records/<recordHash>.json.gz              an out-of-line record, gzip
schemas/<schemaHash>.json                 JCS(schema)
roots/<hex>.json                          JCS(root); <hex> is the version hash without "ulv2:"
private/<commitment>.json                 JCS(private set object); only in locations that hold private sets
files/<fileHash>                          file bytes
collections/<collectionId>/collection.json
collections/<collectionId>/log/<seq>.json
collections/<collectionId>/head.json
```

- **Bodies.** The body of leaf L has one line per entry of L, in entry order, each followed by
  `\n`. The body is one or more gzip members concatenated (RFC 1952 §2.2); readers must accept any
  number of members.
  - A line is either the canonical record (section 4), whose hash is the entry's record hash, or
    an out-of-line pointer `{"$ref":"<recordHash>"}`, whose record is stored in `records/`.
  - Which records go out of line, and where members split, are the writer's choice.
  - For a body with no pointers, the concatenation of a type's bodies in tree order is that type's
    records as gzip NDJSON.
- **Content-addressed objects** (everything except `collections/`) never change once written.
  Readers that don't trust a location verify each object before use:
  - nodes against their hash;
  - body lines against the leaf's record hashes;
  - roots against the version hash;
  - schemas and private set objects against theirs.
- **Write order.** All objects a version reaches (leaves and bodies, then interior nodes, then the
  root and private set object), then the log entry, then `head.json`. A reader that finds
  `head.json` can read everything below it.
- **Self-contained.** Nothing in a location refers to another location.
- Platform-internal data (push sessions, staging uploads, the reference log) is not part of a
  repository and is never copied to one.
- Readers ignore keys outside this layout. The platform's location check writes
  `.underlay/check.json` under the prefix.

### 11.1 Version log

Each collection has one log entry per version:

```
entry = {"actorId","appId","baseSemver","createdAt","keyId","message","prev","semver","seq","sig","versionHash"}
```

- `seq` counts from 1. `createdAt` is ISO 8601 UTC. `appId`, `actorId`, `baseSemver` and
  `message` may be `null`. Pusher identity is not recorded (open question).
- `sig` is base64url (no padding) of the Ed25519 signature over the UTF-8 bytes of JCS(entry
  without `sig`).
- `keyId` names the signing key. It is the first 16 hex characters of hash(raw public key). A
  verifier uses a key only under that id: a key listed under any other id is ignored, so a key list
  read from an untrusted location can't put a stranger's key under a trusted key's id.
- **Entry hash** = hash(JCS(entry)), signature included.
- `prev` is the entry hash of entry `seq − 1`, or `null` for `seq` 1. Entries form a hash chain,
  so a dropped, reordered or altered entry is detectable.
- `head.json` = JCS(`{"entryHash","seq","versionHash"}`) of the latest entry. It is overwritten
  after the entry is written.
- `collection.json` holds the collection's id, owner and slug, its name and description, and
  `keys`: the public keys (`{"id","alg":"Ed25519","publicKey": base64url raw}`) that sign its log.
  The platform also publishes its keys at a well-known URL (to be fixed with the Cloudflare
  deployment).

A log is valid when every entry is present from 1 to `head.seq`, each `prev` chains, each signature
verifies against a trusted key, and `head.entryHash` is the last entry's hash (`verifyLog` in
`packages/protocol/src/repo/log.ts`).

### 11.2 Sync

A version moves between repositories as a **pack**: the repository objects it reaches that the
receiver's base version doesn't, under their repository keys. On the wire a pack is a POSIX tar
(PAX headers for names over 100 bytes), uncompressed; the objects are stored bytes, so most are
gzip already. File bytes are not in packs. Reference implementation: `packVersion` and
`receiveVersion` in `packages/protocol/src/repo/sync.ts`.

- **Contents and order.**
  1. The schemas the base doesn't have.
  2. For each record tree of each set sent, the nodes the base's tree of that type (in that set,
     else in the other set) doesn't have at the same position, parents before children; after
     each new leaf, the out-of-line records its body points to, then the body.
  3. The same for each set's file tree (nodes only).
  4. The private set object, when the private set is sent.
  5. The root, last.
- A pack never holds `collections/` objects; logs and `collection.json` travel separately.
- **Receiving.** Before writing an object, the receiver checks it against its key: nodes and
  out-of-line records by hash, bodies line by line against their leaf's entries (section 8.3; the
  leaf arrives first),
  schemas, private set objects and the root by hash and canonical JSON. Then, for every tree of
  every set received, it re-derives the tree: the entry changes from its base tree, merged into
  that base tree under section 8.1, must give exactly the received root, count and bytes, and
  every new record leaf must have its body. Only then is the root written. A pack that fails any
  check is refused; objects it wrote are unreferenced.

## 12. Limits and constants

All protocol constants are in `packages/protocol/src/constants.ts`, and the vectors file repeats them.

## 13. Format 1 hashes

Format 1 canonicalized `data` and schemas by sorting keys into a new object and then calling
`JSON.stringify`. That puts array-index keys (canonical decimal integers below 2³² − 1) first, in
numeric order.

- The two formats agree whenever no object at any depth has an array-index key.
- When one does, the format 1 hash differs. Servers keep `(format-1 hash → format-2 hash)` aliases,
  and the compatibility push API accepts format 1 hashes from older clients.
- Format 1 version hashes (`private:<hex>`, `public:<hex>`) are kept as aliases of the versions
  they name.

## Test vectors

`packages/protocol/test/vectors/v2.json` holds:

- the constants;
- JCS input and output pairs;
- input-rule verdicts per record line;
- record and schema canonical forms and hashes;
- boundary hashes;
- a key-order list;
- one leaf node and one interior node, spelled out;
- tree roots for several entry sets (empty; one entry; 1,000; 100,000; Unicode keys; a key set with
  no natural boundaries, so every leaf split is forced);
- a file tree;
- two version roots, one with a private set and its commitment;
- file-reference extraction cases.

Tree vectors give a recipe for generating their entries rather than listing them.
`scripts/gen-vectors.ts --check` runs in CI. A failure there means a protocol change, which has to
be deliberate and recorded here.

## Changes from the design plan

These were made during implementation and recorded with their reasons in `edge-redesign-build.md`:

1. Interior entries carry each child's **last** key, not its first. The boundary rule is defined
   on last keys, and a merge needs them to reuse unchanged subtrees without reading them.
2. Record-tree entries carry the record's size, so `bytes` can be verified from nodes alone.
3. Record ids are limited to 1,024 UTF-8 bytes, which bounds node size.
4. The unsafe-integer rule applies to integer literals in the source text.
5. File references have one definition (section 4). Format 1 used two.
6. `LEAF_MAX_ENTRIES` is 8,192 (the plan had 16,384). The chunking rule stays fixed-probability
   rather than size-aware, because size-aware boundaries depend on position and that rules out
   parallel commit units.
7. Roots are stored as `roots/<hex>.json`, without the `ulv2:` prefix, which would put a colon in
   the key.
8. A large leaf body is one object of several concatenated gzip members (section 11). There are no
   separate part objects, so mirrors and third-party readers need only one rule.
9. Tree sync is pull-only (section 11.2): a version moves as a pack the receiver re-derives. The
   plan also had a tree-sync push API; clients that hold their base push a locally computed diff
   through delta push and compare version hashes instead, so a server never accepts tree nodes
   from outside.
