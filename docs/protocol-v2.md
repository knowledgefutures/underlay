# Underlay protocol, format 2

**Status: draft.** Every value marked _provisional_ can still change until the format is frozen.
After the freeze, changing any of them needs a new format number. The reference implementation is
`packages/core` (`@underlay/core`). The test vectors are in `packages/core/test/vectors/v2.json`
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
`packages/core/src/jcs.ts`).

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

- A schema with `"private": true` at its root makes the type private (section 9).
- `"private": true` on a property (field-level privacy) is **rejected** in format 2.
- The validation dialect, and the exact behaviour required of a validator, is **to be specified**
  in phase 2 of the build, after the differential test against production data. Until then, the
  reference validator is the server's.

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
- `count` ≥ 1 for every child.

A node that hashes correctly but breaks a structural rule is invalid. Accepting one would give two
different roots for one entry set. The reference `fsck` is `verifyTree` in
`packages/core/src/tree/verify.ts`.

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

## 11. Limits and constants

All protocol constants are in `packages/core/src/constants.ts`, and the vectors file repeats them.

## 12. Format 1 hashes

Format 1 canonicalized `data` and schemas by sorting keys into a new object and then calling
`JSON.stringify`. That puts array-index keys (canonical decimal integers below 2³² − 1) first, in
numeric order.

- The two formats agree whenever no object at any depth has an array-index key.
- When one does, the format 1 hash differs. Servers keep `(format-1 hash → format-2 hash)` aliases,
  and the compatibility push API accepts format 1 hashes from older clients.
- Format 1 version hashes (`private:<hex>`, `public:<hex>`) are kept as aliases of the versions
  they name.

## Test vectors

`packages/core/test/vectors/v2.json` holds:

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
