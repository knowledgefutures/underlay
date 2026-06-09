---
title: 'Content-Addressed Records'
subtitle: 'Applying the insight that already works for schemas and files to the records themselves.'
date: 2026-06-08
---

Underlay already content-addresses two things: files (binary blobs stored by SHA-256, deduplicated globally) and schemas (type definitions stored by hash, automatically aligned across collections). These are among the best decisions in the system. Files that are identical are stored once. Schemas that are identical are recognized as the same type without coordination.

Records, the actual data, are the one thing we haven't done this for yet. Each record currently belongs to a specific version. If a collection has 10,000 records and a new version adds 5, the system conceptually associates all 10,005 with that version, even though 10,000 are unchanged. Storage scales with versions times records rather than with unique records.

This post describes what changes when we apply the same content-addressing pattern to records, and why it turns out to be the architectural foundation for everything else we want to build: efficient storage, incremental sync, local-first workflows, and provenance that emerges from the data model rather than being bolted on.

## Records as objects

The change is straightforward. Instead of storing records as rows belonging to a version, we store them as content-addressed objects in a global pool, and versions become manifests that reference them by hash.

```
objects/
  ab/cd/abcd1234...    # record content, keyed by SHA-256
  ef/01/ef012345...

versions/
  v1.manifest          # list of record hashes + schema hash
  v2.manifest          # mostly the same hashes, a few new ones
```

A record is a JSONL line: one JSON object with `id`, `type`, and `data` fields, hashed independently. A version is a list of these hashes plus a reference to the schema set. Two versions that share 9,995 records out of 10,000 share 9,995 object references. The 5 new records are the only new storage.

This is how git stores blobs and how Underlay already stores files and schemas. We are applying the same pattern to the one remaining entity type.

## What JSONL has to do with it

The choice of JSONL as the wire and storage format is load-bearing here. Each line is one record, independently parseable, independently hashable. You don't need to parse a surrounding array or hold state across lines. A record's identity is the hash of its JSONL line.

This means:

- **Streaming.** Records can be sent, received, and processed one at a time. No buffering a 500MB JSON array.
- **Grep-friendly.** `grep "some_doi" records.jsonl` finds what you need without a JSON parser.
- **Unix-pipe-friendly.** `wc -l records.jsonl` gives you a record count. `head -n 100` gives you a sample. `sort` and `diff` work.
- **Hash-stable.** One line, one hash. No ambiguity about whitespace or key ordering beyond the line itself.

CSV is the lingua franca of data sharing, and parquet is dominant in analytics. Underlay should import and export both. But the protocol speaks JSONL because it is the serialization of what Underlay actually stores: individually addressable JSON records with a JSON Schema.

## Storage efficiency

The numbers are simple. Consider a collection that is updated weekly for a year. 52 versions, 100,000 records, 500 records change per week on average.

**Without record-level content addressing:** 52 versions x 100,000 records = 5.2 million record-version associations.

**With it:** 100,000 initial records + (52 x 500) new/changed records = 126,000 unique record objects. Each version is a manifest of 100,000 hashes, not 100,000 record copies.

The manifests themselves compress well since they are sorted lists of hashes that share long common prefixes across versions.

## Incremental push and pull

Content addressing turns push and pull into hash negotiations, the same pattern git uses in its pack protocol.

**Push:**

1. Client computes the hashes of records in the new version.
2. Client sends the manifest (list of hashes) to the server.
3. Server responds with which hashes it already has.
4. Client sends only the missing record objects.
5. Server stores new objects, writes the version manifest.

Pushing a version that adds 5 records to a 100,000-record collection sends 5 records, not 100,000.

**Pull:**

1. Client requests the diff between its last-known version and the current version.
2. Server sends the manifest delta: hashes added, hashes removed.
3. Client requests content for hashes it doesn't have locally.
4. Server sends only those records.

Pulling 50 versions of a large collection where most records don't change between versions transfers a fraction of the total data.

This protocol works identically regardless of what is on each end: server to client, client to server, server to server, local store to local store. It is just hash negotiation over record objects.

## Provenance for free

This is perhaps the most interesting consequence. When every record is stored by its content hash, and every version manifest lists which records it includes, you can answer a question that is otherwise expensive: where did this record first appear?

A record with hash `abcd1234` might be referenced by:

- `knowledgefutures/journal-archive` v12 (2025-03-14)
- `university-press/catalog` v7 (2025-06-01)
- `researcher/working-data` v3 (2025-08-20)

The earliest version timestamp across all collections that reference this hash is the first time this exact record was seen in the system. You get provenance from the data model rather than from metadata someone had to remember to attach.

You can also answer: which collections reference this exact record right now? That is a cross-collection join on a single hash, the same O(1) lookup pattern we already have for schemas. It tells you who independently arrived at the same data, the same way schema content addressing tells you who independently arrived at the same type definition.

This doesn't replace rich provenance (who authored this, what was the methodology, what was the chain of custody). Applications embed that in records when they need it. But it gives you a baseline: this exact data existed here first, and these collections also have it. That is more than most data sharing infrastructure provides, and it costs nothing beyond what we are already doing for storage efficiency.

## The local story

Content-addressed records make a local Underlay store practical. The versioning logic (hashing records, constructing manifests, computing diffs, deriving semver) is a library. The server wraps it with HTTP, PostgreSQL, and S3. A local CLI wraps it with the filesystem and SQLite.

```
underlay init my-collection
underlay schema set schema.json
underlay add records.jsonl              # hashes records into .underlay/objects/
underlay status                         # "47 new records, schema unchanged -> minor bump"
underlay commit -m "initial load"       # creates local version v1.0.0
underlay add more-records.jsonl
underlay commit -m "second batch"       # local version v1.1.0
underlay remote add origin underlay.org/my-org/my-collection
underlay push                           # hash negotiation, sends only new objects
```

Pull works the same way in reverse: fetch version manifests, request missing record objects, store them locally. This means you can pull all versions from one server and push them to another. You can work privately on local data, inspect version history with desktop tools, and push when ready. An agent can build up versions locally and push the result.

The `.underlay/` directory is a real content-addressed store, not a pointer. `underlay log`, `underlay diff v3 v7`, and `underlay show v5` all work offline. The server is not special. It is just another Underlay store that happens to be reachable over HTTP.

## What this does not change

The API surface stays the same. You still push records and a schema. You still pull versions and diffs. The content addressing is behind the wall: it changes how records are stored and transferred, not how they are described or used.

Schemas remain first-class, content-addressed, globally deduplicated. Files remain content-addressed by SHA-256 in object storage. Records join them. The system has one storage pattern for everything: hash the content, store it once, reference it by hash. Versions are manifests, not copies.

The simplicity of the interface is preserved. The efficiency of the implementation is transformed.
