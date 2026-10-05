# Underlay protocol, version 2

**Status:** Stable. Frozen 2026-10-03.

**Abstract.** This document specifies version 2 of the Underlay protocol: the canonical encoding
and hashing of records, schemas and files; the input rules a publisher's data must satisfy; the
construction of record and file trees; the version root and its hash; the repository layout in
which collections are stored; the signed version log; the pack format by which versions are
copied; and the HTTP interface by which servers serve and accept versions.

**Change control.** A change to any rule or value that alters which inputs are accepted, how a
tree is built, or what is hashed requires a new protocol version (the `underlay` member of every
root, Section 10). Clarifications and additions that alter none of these are recorded in
[Appendix B](#appendix-b-revision-history).

**Reference implementation.** `@underlay/protocol` (`packages/protocol` in the Underlay
repository). Test vectors: `packages/protocol/test/vectors/v2.json`
([Appendix A](#appendix-a-test-vectors)). Where this document and the reference implementation
disagree, this document is authoritative.

## 1. Conventions and terminology

### 1.1 Requirements language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "NOT RECOMMENDED", "MAY" and "OPTIONAL" in this document are to be interpreted as
described in BCP 14 ([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119),
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)) when, and only when, they appear in all
capitals.

Sections and paragraphs marked _informative_, and all examples and notes, are not normative.

### 1.2 Terminology

- **Collection**: a named sequence of versions, identified by a collection id.
- **Record**: a triple of an id, a type and a JSON value `data` (Section 4).
- **Type**: a named class of records, identified by a type slug and described by a schema.
- **Schema**: a JSON Schema document that the records of one type MUST satisfy (Section 5).
- **File**: a byte string, identified by its hash (Section 6).
- **Access set**: one of the two partitions of a version's content, `public` and `private`
  (Section 9).
- **Tree**: a sorted set of entries partitioned into tree nodes by the rules of Section 8.
- **Tree node**: a leaf or interior node of a tree.
- **Version**: an immutable state of a collection, described by a root document (Section 10).
- **Repository**: the objects that represent one or more collections in a storage location
  (Section 11).
- **Server**: an HTTP service that implements Section 11.3 and, if it accepts publications,
  Section 11.4. Also called an _Underlay node_.
- **Client**: any party that reads from or publishes to a server.
- **Owner**: a party permitted to read a collection's private set. Who is an owner is determined
  by the server.

### 1.3 Notation

- **hash(x)** is the SHA-256 digest of the octet string `x`, written as 64 lowercase hexadecimal
  characters. A string is hashed as its UTF-8 encoding.
- **JCS(v)** is the canonical JSON serialization of the value `v` (Section 2).
- **Key order** is the order defined in Section 7.
- `+` between strings denotes concatenation.
- Sizes are in octets (bytes). KiB and MiB are 2¹⁰ and 2²⁰ octets.
- Counts are non-negative integers not greater than 2⁵³ − 1.

## 2. Canonical JSON

Every JSON document that is hashed MUST be serialized as specified by
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JSON Canonicalization Scheme, JCS):

- no insignificant whitespace;
- strings escaped as by ECMAScript `JSON.stringify`;
- numbers serialized as by ECMAScript `Number.prototype.toString`, with `-0` serialized as `0`;
- object members ordered by the UTF-16 code units of their keys.

Note (informative): ECMAScript objects enumerate integer-like keys (`"9"`, `"10"`) first, in
numeric order, regardless of insertion order. Sorting keys into a new object and serializing it
with `JSON.stringify` therefore does not produce JCS. An implementation in ECMAScript must emit
object members as strings itself (reference: `packages/protocol/src/jcs.ts`).

## 3. Input rules

A client MUST apply these rules to every record line it publishes, and a server MUST apply them to
every record line it receives in a publication (Section 11.4). The rules apply to the whole line,
including members that are otherwise ignored. They are evaluated on the source text, because a
parsed value no longer carries the information they require. A server MUST also apply the syntax,
duplicate key, unsafe integer and lone surrogate rules to the schemas it receives; the depth rule
applies to record lines only.

| Rule            | A line or document is rejected if                                                                                                                                                                                                       | Code               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Syntax          | it is not JSON as defined by RFC 8259, including an unterminated string or an invalid escape                                                                                                                                            | `syntax`           |
| Duplicate keys  | an object has two members whose keys are equal after unescaping                                                                                                                                                                         | `duplicate_key`    |
| Unsafe integers | it contains an integer literal (no fraction, no exponent) whose magnitude exceeds 2⁵³ − 1 (`9007199254740991`). Literals with a fraction or exponent (`1e20`, `9007199254740993.0`) are accepted and take their IEEE 754 binary64 value | `unsafe_integer`   |
| Lone surrogates | a string or key contains a UTF-16 surrogate code unit, literal or `\u`-escaped, that is not part of a surrogate pair                                                                                                                    | `lone_surrogate`   |
| Depth           | the line nests more than `MAX_JSON_DEPTH` + 1 (65) levels. Each object or array is one level and the envelope is level 1, so `data` and every other member may nest 64 levels                                                           | `too_deep`         |
| Envelope        | the line is not an object, has no `data` member, or has a `private` member that is not a boolean                                                                                                                                        | `bad_envelope`     |
| Record id       | `id` is absent, not a string, empty, or longer than `MAX_ID_BYTES` (1,024) UTF-8 bytes                                                                                                                                                  | `bad_id`           |
| Type slug       | `type` is absent, not a string, empty, longer than `MAX_TYPE_BYTES` (128) UTF-8 bytes, begins with `.`, or contains `/`, `\`, U+0000–U+001F or U+007F                                                                                   | `bad_type`         |
| Record size     | the canonical form (Section 4) is longer than `MAX_RECORD_BYTES` (8,388,608) bytes                                                                                                                                                      | `record_too_large` |

A record line that breaks more than one rule MUST be reported with the code of the first rule it
breaks in this order:

1. the text is scanned from the start; the first of an unterminated string or invalid `\u`
   escape (`syntax`), a duplicate key, an unsafe integer, a lone surrogate or an excess of depth
   that occurs in the text determines the code, whether or not the text is otherwise JSON;
   otherwise, a text that is not JSON is `syntax`;
2. `bad_envelope`, if the line is not an object;
3. `bad_id`;
4. `bad_type`;
5. `bad_envelope`, if `data` is absent or `private` is not a boolean;
6. `record_too_large`.

The codes are part of the protocol. A server reports them (Section 11.4).

Members of a record line other than `id`, `type`, `data` and `private` MUST be ignored. They are
not part of the record, its canonical form or its hash.

Strings are not Unicode-normalized. `é` as U+00E9 and as U+0065 U+0301 are distinct ids with
distinct hashes.

## 4. Records

A record consists of an `id` (a string), a `type` (a type slug) and `data` (any JSON value). The
**canonical form** of a record is the string

```
'{"id":' + JCS(id) + ',"type":' + JCS(type) + ',"data":' + JCS(data) + '}'
```

The envelope members appear in the fixed order `id`, `type`, `data`; only `data` is canonicalized
under Section 2.

- **Record hash** = hash(canonical form).
- **Record size** = the length of the canonical form in bytes.
- Within a version, a (type, id) pair MUST identify at most one record, across both access sets.

**File references.** A record references a file through any object, at any depth of `data`,
whose `$file` member is a string consisting of `sha256:` followed by 64 lowercase hexadecimal
characters. The referenced file hash is the hexadecimal part. An object that is a file reference
is not searched for further references. An object whose `$file` member has any other value is not
a reference, and its members are searched as usual.

## 5. Schemas

A type's schema is a JSON object that is a JSON Schema draft-07 document (Section 5.1).
**Schema hash** = hash(JCS(schema)).

A schema MUST be rejected if:

- its root `private` member is present and is not a boolean;
- a schema that is the value of a member of a `properties` object, at any depth, has
  `"private": true` (field-level privacy is not supported);
- its canonical form is longer than `MAX_SCHEMA_BYTES` (262,144) bytes;
- any `pattern` value or `patternProperties` key is longer than `MAX_PATTERN_LENGTH` (256) UTF-16
  code units. A `pattern` member inside `const`, `enum`, `default` or `examples` is data, not a
  regular expression, and is not limited;
- the slug it is given under is not a valid type slug (Section 3).

A root `"private": true` makes the type private (Section 9).

### 5.1 Validation dialect

**Acceptance of schemas.** A schema MUST be rejected unless:

- its root `$schema` member, if present, is `http://json-schema.org/draft-07/schema` or
  `http://json-schema.org/draft-07/schema#`;
- it is valid against the draft-07 meta-schema;
- every `pattern` value and `patternProperties` key compiles as an ECMAScript regular expression
  with the `u` flag;
- every `$ref` resolves within the schema or to the draft-07 meta-schema. References are resolved
  against the base URI `https://schema.underlay.invalid/` unless a `$id` establishes another.

**Validation of records.** A record's `data` MUST be validated against its type's schema under
draft-07, with these refinements:

- keywords adjacent to `$ref` are applied, as in draft 2019-09;
- keywords not defined by draft-07 are ignored, including later drafts' keywords
  (`unevaluatedProperties`, `dependentRequired`, `prefixItems`, …) and draft-04's `id`. `$defs`
  is honoured as a container of subschemas, and `$anchor` is honoured;
- `pattern` is an ECMAScript regular expression with the `u` flag;
- `multipleOf` m accepts x when the floating-point remainder r = x mod m satisfies
  |r| < 1.1920929 × 10⁻⁷ or |m − r| < 1.1920929 × 10⁻⁷;
- string length is measured in Unicode code points;
- object members are the parsed document's own keys; names such as `__proto__` and `toString`
  have no special meaning.

**Formats.** `format` constrains strings only, and only for the names `date`, `time`,
`date-time`, `iso-time`, `iso-date-time`, `duration`, `uri`, `uri-reference`, `uri-template`,
`url`, `email`, `hostname`, `ipv4`, `ipv6`, `regex`, `uuid`, `json-pointer`,
`json-pointer-uri-fragment`, `relative-json-pointer` and `byte`. Each is defined as in
ajv-formats 3.0 in "full" mode. In particular, `date-time` and `time` require a time zone,
`date-time` accepts `T`, `t` or whitespace as the separator, and `email` requires a dot in the
domain. Other format names are ignored.

Only the verdict (valid or invalid) is normative. Error messages, and the number of errors
reported, are not.

Note (informative): the reference validator is `@cfworker/json-schema` with these refinements
(`packages/protocol/src/validate.ts`). Over all public production data it gives the same verdicts
as the AJV configuration of Underlay v1 (139 schemas, 330,300 records, 85,773 mutated records).

## 6. Files

**File hash** = hash(the file's bytes). A file's **size** is its length in bytes.

## 7. Key order and boundary hash

- **Key order.** Keys are compared lexicographically by their UTF-8 encodings, octet by octet; a
  proper prefix precedes the longer key. This is Unicode code point order. Implementations MUST
  NOT compare UTF-16 code units (ECMAScript's default `<` and `sort()`), which order differently
  when one key has a character at or above U+10000 where the other has one in U+E000–U+FFFF.
- **Boundary hash.** u(k) is the first 8 bytes of hash(k), read as a big-endian unsigned 64-bit
  integer.
- **tz(k)** is the number of trailing zero bits of u(k), from 0 to 64.

## 8. Trees

A tree is a set of entries with unique keys, in key order, partitioned into tree nodes. There are
two kinds:

| Kind        | Key             | Entry                          | Entry size   |
| ----------- | --------------- | ------------------------------ | ------------ |
| Record tree | record id       | `[id, recordHash, recordSize]` | `recordSize` |
| File tree   | file hash (hex) | `[fileHash, fileSize]`         | `fileSize`   |

### 8.1 Shape

| Parameter                     | Value |
| ----------------------------- | ----- |
| `LEAF_BOUNDARY_BITS`          | 10    |
| `INTERIOR_BOUNDARY_BITS_STEP` | 6     |
| `LEAF_MAX_ENTRIES`            | 8,192 |
| `INTERIOR_MAX_CHILDREN`       | 1,024 |

- **Leaves (level 0).** The entries are taken in key order. The current leaf ends after entry
  `k` if tz(k) ≥ 10, if the leaf holds `LEAF_MAX_ENTRIES` entries, or if `k` is the last entry.
- **Interior level i, i ≥ 1.** The nodes of level i − 1 are taken in order. The current level-i
  node ends after child `c` if 10 + 6i ≤ 64 and tz(last key of `c`) ≥ 10 + 6i, if the node has
  `INTERIOR_MAX_CHILDREN` children, or if `c` is the last node of level i − 1.
- **Root.** Levels are built in ascending order. The root is the single node of the lowest level
  that has exactly one node. If the tree has one leaf, that leaf is the root. An empty tree has no
  nodes, and its root is `null`.

Consequences (informative): the same entry set yields the same tree regardless of construction
order; a natural boundary (tz(k) ≥ 10) depends only on its key, and a forced split only on the
position since the preceding boundary; any range between two natural boundaries can therefore be
rebuilt independently. The mean leaf holds 1,024 entries and the mean interior fan-out is 64.

### 8.2 Node encoding

```
leaf:      {"e":[entry, ...],"t":"leaf"}
interior:  {"e":[[lastKey, childHash, count, bytes], ...],"l":level,"t":"node"}
```

- A node is encoded as JCS, which places members in the order shown.
- `lastKey` is the last key under the child, `childHash` the child's node hash, `count` the number
  of entries under the child, and `bytes` the sum of their entry sizes. `level` is the node's
  level.
- **Node hash** = hash(encoded node).

### 8.3 Validity

A tree is valid if and only if building its entries under Section 8.1 yields the same root hash.

A receiver of tree nodes from another party (Section 11.2) MUST reject a node unless:

- its bytes hash to the expected node hash and are its canonical encoding;
- its keys are strictly increasing, within the node and across the tree;
- each interior entry's `lastKey`, `count` and `bytes` equal those of the child it names, and
  `count` ≥ 1;
- each child is exactly one level below its parent;
- in a record tree, each key is a valid record id (Section 3).

A receiver MUST reject a record leaf unless each of its entries matches the corresponding line of
the leaf's body (Section 11), with an out-of-line pointer resolved to its record: the line hashes
to the entry's record hash, is exactly the entry's size in bytes, and is the canonical form of a
record whose `id` is the entry's key and whose `type` is the type of the tree.

A node that hashes correctly but violates a structural rule is invalid; accepting it would admit
two roots for one entry set.

Record documents (members `id`, `type`, `data`) and node documents (members `e`, `l`, `t`) have
disjoint member names, so neither can be interpreted as the other.

## 9. Access sets

Each version has two access sets, `public` and `private`.

- **Records.** A record published with `"private": true`, and every record of a private type,
  belongs to the private set. Every other record belongs to the public set.
- **Types.** Each set lists, for each type it contains, the type's schema hash and the root of the
  tree of that set's records of the type.
  - A private type appears in the private set only.
  - A public type appears in the public set, including when it has no public records (with a
    `null` root). It also appears in the private set if it has private records.
- **Files.** A file belongs to each set that contains a record referencing it. A file declared in
  a publication (`files.add`, Section 11.4) also belongs to the private set, whether or not records
  reference it, and remains declared in later versions until a publication removes the declaration
  (`files.remove`).
- **Readers.** Owners MAY read both sets. Any other reader MAY read the public set only. Whether a
  collection is visible to non-owners at all is collection state outside the version.

## 10. Versions

```
SetObject = {
  "types": { slug: { "schema": schemaHash, "root": treeHash | null, "count": n, "bytes": b }, ... },
  "files": { "root": treeHash | null, "count": n, "bytes": b }
}
PrivateSetObject = SetObject + { "salt": 64 hex characters }
root = { "underlay": 2, "metadata": object | null, "public": SetObject, "private": commitment | null }
```

- `count` and `bytes` are the tree root's totals, or 0 for a `null` root.
- **Commitment** = hash(JCS(PrivateSetObject)).
- The salt is 32 random bytes, encoded as hexadecimal. A writer MUST choose it once per collection
  and MUST reuse it for every version of that collection, so that an unchanged private set keeps
  its commitment.
- `private` is `null` if and only if the private set is empty: it lists no types and no files.
- **Version hash** = `"ulv2:"` + hash(JCS(root)).

A version hash commits to content only. A root has no parent pointer; identical content yields the
same version hash in any collection, except where a private set is present, since salts differ
between collections. Lineage, semver, messages and authorship are recorded in the version log
(Section 11.1).

A reader of the public set can verify the version hash and every object of the public set, and
learns of the private set only whether it exists. An owner additionally obtains the
PrivateSetObject, including its salt, and can verify it against the commitment.

### 10.1 Semver

Each version of a collection has a semver of the form `v<major>.<minor>.<patch>`. The server that
commits a version MUST assign it from the differences between the version and its base
(Section 11.4), with M, m and p the base's major, minor and patch:

1. The first version of a collection is `v1.0.0`.
2. If a type was added or removed, or a type's schema hash changed, the semver is `v(M+1).0.0`.
   Making a type private or public changes its schema and is therefore covered by this rule.
   When a type's schema changes, every record of the type carried over from the base MUST be
   validated against the new schema, and the publication MUST be refused if any fails.
3. Otherwise, if any record was added, removed or changed in either set, the semver is
   `vM.(m+1).0`. A record moving between sets is a change.
4. Otherwise (only the metadata or the file sets changed), the semver is `vM.m.(p+1)`.

A publication whose version hash equals its base's version hash MUST NOT create a version.

Semvers are unique within a collection and strictly increasing. A version converted from Underlay
v1 retains the semver it had in v1.

## 11. Repository layout

A repository is the representation of collections in a storage location (an object store such
as an S3-compatible bucket). The layout is identical in a server's own storage and in a mirror.
Keys are relative to the location's prefix.

```
nodes/<nodeHash>                             encoded node (Section 8.2), gzip
bodies/<leafHash>.ndjson.gz                  the body of a record leaf
records/<recordHash>.json.gz                 an out-of-line record, gzip
schemas/<schemaHash>.json                    JCS(schema)
roots/<hex>.json                             JCS(root); <hex> is the version hash without "ulv2:"
private/<commitment>.json                    JCS(PrivateSetObject); only where private sets are held
files/<fileHash>                             file bytes
collections/<collectionId>/collection.json   collection description (Section 11.1)
collections/<collectionId>/log/<seq>.json    version log entry
collections/<collectionId>/head.json         log head
```

- **Bodies.** The body of a record leaf contains one line per entry of the leaf, in entry order,
  each terminated by `\n`. A line is either the canonical form of the entry's record or an
  out-of-line pointer `{"$ref":"<recordHash>"}`, in which case the record is stored at
  `records/<recordHash>.json.gz`. A body is one or more concatenated gzip members (RFC 1952
  §2.2); readers MUST accept any number of members. Which records are stored out of line, and
  where members divide, are the writer's choice.
- **Immutability.** Every object outside `collections/` is content-addressed and MUST NOT change
  once written. A reader that does not trust a location MUST verify each object before use: nodes
  against their hash, body lines against the leaf's entries, roots against the version hash, and
  schemas and PrivateSetObjects against their hashes.
- **Write order.** A writer MUST write every object a version reaches (leaves and their bodies,
  then interior nodes, then the PrivateSetObject and root) before the version's log entry, and the
  log entry before `head.json`. A reader that finds `head.json` can therefore read every object
  it reaches.
- **Self-containment.** No object in a location refers to another location.
- Readers MUST ignore keys outside this layout.

Note (informative): with no out-of-line pointers, the concatenation of a type's bodies in tree
order is that type's records as gzip-compressed NDJSON. Data internal to a server (push sessions,
staged uploads, indexes) is not part of a repository. The reference server's location check
writes `.underlay/check.json` under the prefix.

### 11.1 Version log

Each collection has one log entry per version:

```
entry = {"actorId","appId","baseSemver","collectionId","createdAt","keyId","message","prev","semver","seq","sig","versionHash"}
```

- `collectionId` is the id of the collection whose log contains the entry. It is signed, so that
  an entry or a log cannot be presented as another collection's.
- `seq` is the version's position in the log, starting at 1. `semver` and `versionHash` identify
  the version; `baseSemver` is its base's semver.
- `createdAt` is an ISO 8601 timestamp in UTC.
- `appId`, `actorId`, `baseSemver` and `message` MAY be `null`. Writers SHOULD write `actorId` as
  `null`, since a log is as public as its collection; the member is retained so that existing
  entries verify.
- `keyId` is the first 16 hexadecimal characters of hash(raw public key) of the signing key.
- `sig` is the Ed25519 signature over the UTF-8 encoding of JCS(entry without `sig`), encoded as
  base64url without padding.
- **Entry hash** = hash(JCS(entry)), with `sig` included.
- `prev` is the entry hash of entry `seq − 1`, or `null` when `seq` is 1.
- `head.json` is JCS(`{"entryHash","seq","versionHash"}`) of the latest entry. It is overwritten
  after each new entry is written.
- `collection.json` is a JSON object with the collection's `id`, `owner`, `slug` and `name`, and
  `keys`: an array of `{"id", "alg": "Ed25519", "publicKey"}`, where `publicKey` is the raw
  public key in base64url. It is neither hashed nor signed. Readers MUST parse it as JSON and MUST
  NOT depend on its serialization.

A verifier MUST use a key only under the id derived from it: a key listed under any other id MUST
be ignored.

A log is valid if and only if every entry from 1 to `head.seq` is present; every entry's
`collectionId` names the collection being read; every `prev` equals the entry hash of the
preceding entry; every signature verifies under a trusted key; and `head.entryHash` and
`head.versionHash` equal the last entry's hash and `versionHash`.

Which keys a verifier trusts is not specified by this version of the protocol (Section 13).

### 11.2 Packs

A version is transferred between repositories as a **pack**: the repository objects the version
reaches that the receiver's base version does not, each under its repository key. A pack is an
uncompressed POSIX tar archive, with PAX extended headers for names longer than 100 bytes. Objects
are carried as stored. File bytes and `collections/` objects are not carried in packs.

A pack contains, in this order:

1. the schemas the base does not have;
2. for each set sent, public first: for each of the set's record trees, the tree nodes not present
   at the same position in the base's tree of that type (in the same set, otherwise in the other
   set), parents before children, and after each new leaf the out-of-line records its body points
   to, then its body; then the new tree nodes of the set's file tree, in the same way;
3. the PrivateSetObject, if the private set is sent;
4. the root.

A receiver MUST NOT depend on any order except that a leaf precedes its body, out-of-line records
precede the body that points to them, and the root is last.

A receiver MUST, before writing an object, verify it against its key: tree nodes and out-of-line
records by hash; bodies line by line against their leaf's entries (Section 8.3), the leaf having
arrived first; and schemas, the PrivateSetObject and the root by hash and canonical form. It MUST
reject a root that does not have exactly the members of Section 10, with `underlay` equal to 2,
`metadata` an object or `null`, valid type slugs, and set totals of 0 for `null` roots, and a
PrivateSetObject that is empty or lacks a 64-hex `salt`. It MUST then, for every tree of every set received, merge the entry changes from its base tree into that
base tree under Section 8.1 and obtain exactly the received root, count and bytes, and MUST hold a
body for every new record leaf. It MUST write the root only after all checks pass, and MUST refuse
a pack that fails any check.

### 11.3 Serving over HTTP

A server serves each collection under a **collection URL**: an absolute URL without a trailing
slash, relative to which the paths below are resolved. The form of collection URLs is the
server's choice.

```
GET  <collection>/log?after=<seq>&limit=<n>
GET  <collection>/versions/<v>/pack?base=<v>&sets=public|all
GET  <collection>/versions/<v>/manifest?cursor=<c>&limit=<n>
GET  <collection>/files/<fileHash>
HEAD <collection>/files/<fileHash>
```

**Version selectors.** `<v>` is a semver (the leading `v` is optional), a version hash
(`ulv2:<hex>`), or `latest`. A version hash that names several versions of the collection (a
reverted change repeats a hash) selects the latest of them. A `base` MUST name a version of the
same collection.

**Log.** The response is 200 with a JSON object `{"collection", "head", "entries"}`:

- `collection` is the collection's `collection.json` (Section 11.1) and `head` its `head.json`;
  either MAY be `null` before the first version;
- `entries` are the log entries with `seq` greater than `after` (default 0), in ascending `seq`
  order, at most `limit` of them. A server MAY cap `limit` and MAY return fewer entries than
  requested. A client
  obtains the remainder by repeating the request with `after` set to the last `seq` received, until
  it reaches `head.seq`.

**Pack.** The response is 200 with the pack (Section 11.2) of version `<v>` against `base`, with
content type `application/x-tar`. Without `base`, the pack holds every object the version
reaches. `sets` defaults to `public`; `all` includes the private set. The response carries the
headers `x-underlay-version` (the version hash), `x-underlay-base` (the base's version hash, or
empty) and `x-underlay-sets` (the sets sent).

**Manifest.** The response is 200 with the version's records as the caller may read them, without
bodies:

```
{"semver", "hash", "schemas": {slug: schemaHash}, "records": [{"id", "type", "hash", "private"?}],
 "pagination": {"limit", "hasMore", "nextCursor"}}
```

- Records are in order of type, then id, each in key order (Section 7). A record of the private
  set carries `"private": true`. A caller who cannot read the private set receives the public set
  only.
- A page holds at most `limit` records; a server MAY cap `limit`. While `hasMore` is true, a client
  obtains the next page by repeating the request with `cursor` set to `nextCursor`. Cursors are
  opaque.

**Files.** The response is the file's bytes, or a redirect to them. A `HEAD` response carries
`content-length`. `<fileHash>` is 64 hexadecimal characters, optionally prefixed with `sha256:`. A
server MUST serve a file only to a caller who may read a set that holds it (Section 9).

**Errors.** Error responses carry a JSON body `{"error": <message>}`.

- 404: the collection, version, base or file does not exist or the caller may not read it. A
  server MUST NOT distinguish these cases.
- 403: `sets=all` was requested by a caller who may read the public set but not the private set.
- 400: `sets` is neither `public` nor `all`.
- 451: the server may not serve a file the caller could otherwise read, for legal reasons. A
  server MUST answer 404 rather than 451 for a file the caller may not read.
- Other statuses carry their HTTP meanings, including 401 for invalid credentials and 429, with
  `Retry-After`, for rate limiting.

**Authentication** is the server's choice. A server without access control MUST serve public sets
only and MUST answer `sets=all` with 403.

**Verification.** A client MUST NOT trust a server's responses: it verifies the log under
Section 11.1, receives packs under Section 11.2, and verifies file bytes against their hash. A
copy obtained from any server, including a mirror operated by a third party, then carries the same
guarantees as one obtained from the origin. The manifest is not verifiable on its own; a client
that requires proof of content reads packs.

### 11.4 Publishing

A client publishes a version by **delta push**: it opens a session against a base version,
uploads the records it adds or changes and the ids it deletes, and commits. The server builds the
trees, writes and signs the log entry, and assigns the semver (Section 10.1). Delta push is the
only publication mechanism; a server MUST NOT accept tree nodes or packs from clients.

```
POST   <collection>/push                  open a session
POST   <collection>/push/<sid>/records    upload records (NDJSON)
POST   <collection>/push/<sid>/deletes    upload deletes (NDJSON)
PUT    <collection>/files/<fileHash>      upload a file
POST   <collection>/push/<sid>/commit     commit
GET    <collection>/push/<sid>            session status
DELETE <collection>/push/<sid>            abandon the session
```

**Opening a session.** The request body is a JSON object. Every member is OPTIONAL.

| Member                 | Meaning                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `base`                 | The semver of the version the changes are against. If it is not the collection's head, the server MUST answer 409 with `currentVersion`. `null` or absent: the head at the time of opening |
| `schemas`              | The complete type set, slug → schema (Section 5). It replaces the base's type set; a type omitted is removed with its records. Absent: the base's type set                                 |
| `metadata`             | Replaces the base's metadata. An object or `null`                                                                                                                                          |
| `metadata_patch`       | An object whose top-level members are merged into the base's metadata. Ignored if `metadata` is present. With neither, the base's metadata is kept                                         |
| `files`                | `{"add": [fileHash, …], "remove": [fileHash, …]}`: files to declare or remove in addition to those records reference (Section 9)                                                           |
| `message`              | A string recorded in the log entry                                                                                                                                                         |
| `app_id`, `actor_id`   | Strings identifying the publishing application and actor                                                                                                                                   |
| `strip_unknown_fields` | A boolean; see **Records**                                                                                                                                                                 |

The response is 200 with `{"session_id", "base", "needed_files", "expires_at", "limits"}`:

- `base` is the semver the session is against, or `null` if the collection has no versions;
- `needed_files` lists the declared files the server does not hold for the collection; the client
  MUST upload them before committing;
- `expires_at` is when the session expires; it is extended by each records or deletes request;
- `limits` are the server's limits, by which a client MUST size its requests:

| Limit                  | Meaning                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `open_bytes`           | Maximum body of the open request, in bytes                        |
| `batch_bytes`          | Maximum body of a records or deletes request, in bytes            |
| `batch_lines`          | Maximum lines in a records or deletes request                     |
| `session_idle_seconds` | Time without an upload after which an open session expires        |
| `open_sessions`        | Maximum sessions one user may have open or committing at once     |
| `file_bytes`           | Maximum file size accepted by `PUT <collection>/files/<fileHash>` |

**Records.** `POST …/records` takes NDJSON record lines `{"id", "type", "data", "private"?}` and
answers 200 with `{"received": n}`. Each line MUST satisfy the input rules (Section 3) and its
type's schema (Section 5.1), and its type MUST be in the session's type set.

- If `data` is an object with top-level members not listed in its schema's root `properties`, the
  record MUST be refused, unless the session set `strip_unknown_fields`, in which case those
  members are removed before the record is hashed. A schema without root `properties` admits any
  members.
- `"private": true` places the record in the private set (Section 9).
- If any line fails, the server MUST answer 422 with `validationErrors`, one per failing line
  identified by its 1-based `line` number among the request's non-empty lines, and MUST store
  nothing from the request. A server MAY list only the first failures, with `totalErrors` giving
  their number.

**Deletes.** `POST …/deletes` takes NDJSON lines `{"type", "id"}` and answers 200 with
`{"received": n}`. The type MUST be in the session's type set. Deleting a (type, id) the base does
not hold is not an error.

A records or deletes request with no lines is answered with 400.

Within a session, the later upload of a (type, id) supersedes an earlier one, whether either is a
record or a delete. Uploads MAY be repeated and divided across any number of requests.

**Files.** `PUT <collection>/files/<fileHash>` with the file's bytes stores the file for the
collection. The server answers 201, or 400 if the bytes do not hash to `<fileHash>`. A server MAY
offer other upload mechanisms for larger files. Every file referenced by a new record, and every
declared file, MUST be held for the collection when the session is committed. A file is held for a
collection if it is in a file tree of the base version, if it was in the public set of any earlier
version of the collection, or if its bytes were uploaded to the collection. A file held only for
another collection is not held. A server MUST hash the bytes of every upload, including when it
already stores the file.

**Commit.** `POST …/commit` builds the version.

- 201 with `{"semver", "hash", "recordCount", "fileCount", "changes": {"added", "removed",
"updated"}}` when the commit completes within the request.
- 202 with `{"session_id", "status": "committing"}` when the commit runs in the background. A
  client MAY request this with `?async=true`; a server MAY choose it for any commit. The client
  polls `GET …/push/<sid>` until `status` is `committed`, when `result` holds the 201 body, or
  `failed`, when `error` holds the failure body.
- Committing a session that has already committed answers 201 with the same body.
- A client that holds the base SHOULD compute the new version's hash itself and compare it with
  `hash`.

**Clients without a copy** (informative). A client that keeps no copy of the collection reads the
base's manifest (Section 11.3), compares each of its records with the manifest by (type, id),
hash and set, uploads the records that are new, changed or moved between sets, and deletes the
(type, id) pairs it no longer has. The upload is then proportional to the changes.

**Errors.** Errors carry a JSON body `{"error": <message>}`. Authentication and 404 follow
Section 11.3.

- 403: the caller may read the collection but not publish to it, or the session belongs to
  another user.
- 400: a malformed body, a `metadata` that is neither an object nor `null`, or a request with no
  lines.
- 409: `base` is not the head (with `currentVersion`); the head changed before the commit; the
  session is not open; or the publication changes nothing (with the head's `hash`).
- 413: a body exceeds `open_bytes` or `batch_bytes`, a request exceeds `batch_lines`, or a file
  exceeds `file_bytes`.
- 422: records or deletes fail; a schema is refused; records carried over from the base fail a
  changed schema (`validationErrors`); or the commit lacks files (`filesNeeded`).
- 429: the user has `open_sessions` sessions open or committing, or a rate limit applies (with
  `Retry-After`).

## 12. Limits and constants

| Constant                      | Value                           | Section |
| ----------------------------- | ------------------------------- | ------- |
| `PROTOCOL_VERSION`            | 2                               | 10      |
| `VERSION_HASH_PREFIX`         | `ulv2:`                         | 10      |
| `LEAF_BOUNDARY_BITS`          | 10                              | 8.1     |
| `INTERIOR_BOUNDARY_BITS_STEP` | 6                               | 8.1     |
| `LEAF_MAX_ENTRIES`            | 8,192                           | 8.1     |
| `INTERIOR_MAX_CHILDREN`       | 1,024                           | 8.1     |
| `MAX_SAFE_INTEGER_LITERAL`    | 9,007,199,254,740,991 (2⁵³ − 1) | 3       |
| `MAX_JSON_DEPTH`              | 64                              | 3       |
| `MAX_RECORD_BYTES`            | 8,388,608 (8 MiB)               | 3       |
| `MAX_ID_BYTES`                | 1,024                           | 3       |
| `MAX_TYPE_BYTES`              | 128                             | 3       |
| `MAX_SCHEMA_BYTES`            | 262,144 (256 KiB)               | 5       |
| `MAX_PATTERN_LENGTH`          | 256 (UTF-16 code units)         | 5       |

The reference implementation defines these in `packages/protocol/src/constants.ts`; the
test vectors repeat them.

Server limits (Section 11.4) are not protocol constants. Informative: underlay.org advertises
`open_bytes` 8 MiB, `batch_bytes` 16 MiB, `batch_lines` 10,000, `session_idle_seconds` 3,600,
`open_sessions` 20 and `file_bytes` 32 MiB; caps log pages at 1,000 entries and manifest pages at
25,000 records; stores records over 64 KiB out of line; and commits in the background when a
session uploaded more than 100,000 records or a schema change revalidates more than 100,000.

## 13. Security considerations

- **Existence.** A server answers 404, not 403, for content a caller may not read (Section
  11.3), so that a response does not confirm the content exists.
- **Content by hash.** A server MUST NOT serve a tree node or body by hash alone, and MUST serve a
  record, schema or file located by hash only where it occurs in a set the caller may read.
  Otherwise a small private object with guessable content could be confirmed by computing its
  hash.
- **Presence during publication.** A server MUST NOT treat content it holds for other collections
  as present in a session. Records are always uploaded in full, and a file counts only if it is
  held for the collection (Section 11.4). This prevents a publisher from confirming, or binding
  into its own collection, content it does not possess.
- **Private set commitment.** The salt prevents confirmation of guessed private content from the
  commitment. Because `private` is `null` exactly when the private set is empty, the root reveals
  whether a private set exists.
- **Split views.** A version hash proves a version's content, not that a server shows every reader
  the same versions. The hash-chained, signed version log (Section 11.1) makes omission and
  reordering detectable by readers who compare log heads.
- **Signing key trust (open issue).** This version of the protocol does not specify how a verifier
  obtains trusted signing keys. A verifier that trusts the keys listed in a `collection.json`
  served by an untrusted server can be presented with a forged history on first contact. The
  reference client trusts the keys of the `collection.json` it is served and anchors on the last
  entry it has verified.
- **File serving.** File bytes SHOULD be served from an origin separate from the server's own
  pages, and with `Content-Disposition: attachment`, so that an uploaded HTML or SVG file cannot
  run in the server's origin.

## Appendix A. Test vectors

`packages/protocol/test/vectors/v2.json` contains:

- the constants (Section 12);
- JCS input and output pairs;
- input-rule verdicts per record line (`inputRules`), covering every code, the depth limit at
  its boundary and the order of codes; and, for lines too long to list, a recipe and verdict
  (`inputRuleRecipes`), covering the record size limit at its boundary;
- schema acceptance verdicts (`schemaRules`): schemas, with the slug each is given under,
  accepted or rejected under Sections 5 and 5.1;
- canonical forms and hashes of records and schemas;
- boundary hashes;
- a list in key order;
- one leaf and one interior node, encoded;
- tree roots for several entry sets: empty, one entry, 1,000 and 100,000 entries, Unicode keys,
  and a key set with no natural boundaries, so that every leaf split is forced;
- a file tree;
- two version roots, one with a private set and its commitment;
- file-reference extraction cases;
- one signed log entry, with the key seed that signed it, its signed bytes, its entry hash and the
  corresponding `head.json`.

Tree vectors give a recipe for generating their entries rather than listing them. Ed25519
signatures are deterministic, so the log entry vector is reproducible.
`packages/protocol/scripts/gen-vectors.ts --check` regenerates the vectors and fails on any
difference.

## Appendix B. Revision history

Changes made while implementing the design (rationale in `edge-redesign-build.md`):

1. Interior entries carry each child's last key, not its first. The boundary rule is defined on
   last keys, and a merge needs them to reuse unchanged subtrees without reading them.
2. Record-tree entries carry the record's size, so `bytes` can be verified from nodes alone.
3. Record ids are limited to 1,024 UTF-8 bytes, which bounds node size.
4. The unsafe-integer rule applies to integer literals in the source text.
5. File references have one definition (Section 4); v1 had two.
6. `LEAF_MAX_ENTRIES` is 8,192 (the design had 16,384). Chunking remains fixed-probability rather
   than size-aware, since size-aware boundaries depend on position and preclude independent
   rebuilding of ranges.
7. Roots are stored as `roots/<hex>.json`, without the `ulv2:` prefix.
8. A record leaf's body is one object of one or more gzip members (Section 11), not several
   objects.
9. Packs are pull-only (Section 11.2). Clients publish by delta push (Section 11.4); a server
   accepts no tree nodes from outside.
10. Log entries carry `collectionId` (Section 11.1). Added 2026-10-03, before any log held real
    data.

Clarifications that change no hash, tree or accepted input:

11. 2026-10-04: "format 2" renamed "protocol v2". In the reference implementation
    `FORMAT_VERSION` became `PROTOCOL_VERSION`, and the vectors file's top-level `format` member
    became `protocolVersion`.
12. 2026-10-04: `actorId` written as `null` (Section 11.1).
13. 2026-10-04: `head.versionHash` checked against the last entry (Section 11.1);
    `MAX_PATTERN_LENGTH` declared and counted in UTF-16 code units, and `pattern` members inside
    `const`, `enum`, `default` and `examples` exempted (Section 5); `bad_id` and `bad_type` for
    absent members, and the order of input-rule codes, stated (Section 3); extra members of a
    record line ignored (Section 3); `collection.json` serialization declared non-normative
    (Section 11.1).
14. 2026-10-05: rewritten in normative form, with requirements language, terminology, a constants
    table and security considerations, and aligned with the reference implementation: the input
    rules apply to the whole record line, depth included, and their codes follow text order
    (Section 3); field-level privacy is defined on `properties` members (Section 5); a declared
    file belongs to the private set whether or not records reference it, and stays declared until
    removed, where the earlier "unless the push marks it public" described no mechanism
    (Section 9); revalidation on a schema change (Section 10.1); `collection.json` has no
    `description` (Section 11.1); packs are ordered set by set (Section 11.2); which files are
    held for a collection, and the 400, 451 and repeated-commit responses (Sections 11.3, 11.4).
15. 2026-10-05: the reference implementation brought into line with this document, changing no
    hash or tree: a key with an invalid escape is `syntax`, not an exception, and a `\u` escape
    needs exactly four hex digits (Section 3); field-level `private` and the pattern limit apply
    to subschemas whose names are also data keywords (Section 5); a receiver checks the shape of
    the root and PrivateSetObject (Section 11.2). The test vectors add `syntax`, `bad_type`,
    depth-boundary and code-order cases, `inputRuleRecipes` (`record_too_large`) and
    `schemaRules` (Sections 5, 5.1); existing vectors are unchanged.
