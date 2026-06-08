---
title: 'Permanently Addressable Structured Data'
subtitle: 'What Underlay is, why it matters now, and how it works.'
date: 2026-06-08
---

Underlay is a protocol for giving structured data a permanent address. You push JSON records and a JSON Schema. You get back a versioned, content-addressed snapshot you can point to forever. Schemas are first-class objects: inspectable, comparable, and alignable across independently authored datasets. That is the whole primitive. Everything else, querying, transforming, collaborating, aligning across datasets, is built on top by agents and people, not by the infrastructure.

## The simple core

Underlay does one thing: you give it records and a schema, it versions and preserves them, and anyone can pull a specific version and know exactly what they are getting.

The core contract:

1. Push JSON records conforming to a JSON Schema.
2. Underlay stores them as an immutable, content-addressed version.
3. Each version gets a semver: schema changed (major), records changed (minor), metadata only (patch).
4. Version 14 of a collection will always return exactly the same records and schema.
5. You can diff between any two versions to see what changed.

The simplicity is the point. An agent, an application, a scraper, a researcher: they all interact with the same primitive. Push records in, pull records out, trust the versions. The intelligence lives in the actors, not the store.

## Why this matters now

This idea has been around for a decade and never quite worked. Structured data sharing has always required agreement before contribution. Linked data, the semantic web, standardized ontologies: they all demanded that everyone adopt the same schema before they could participate. That is a coordination problem that does not scale, and it blocked every previous attempt.

LLMs change this equation. A language model can look at two independently authored schemas and figure out that your `author_name` is my `creator` is their `contributor.displayName`. Alignment happens after the fact, not before. The infrastructure does not need to solve interoperability. It needs to provide enough structure that interoperability can be solved dynamically, by the tools and models that consume the data.

The key is that schemas are first-class, inspectable, content-addressed objects. They are not metadata buried in a file header. They are addressable things that can be compared, searched, and reasoned about. Two collections that independently define the same Author type produce the same schema hash: alignment falls out of the data model automatically. An LLM has something concrete to work with, not a blob to guess at.

The practical consequence: you do not need to agree on anything before contributing. Push what you have, in whatever structure you have it. The schemas make it legible. The models make it interoperable.

## How it compares

GitHub versions code. Hugging Face versions dataset files. Underlay versions structured knowledge, and knows what structure means.

**GitHub** can store JSON files in a repository, but git diffs are line-oriented. Change one field in one record of a large JSON file and you get a line diff, not a semantic one. Git does not know what a "record" is, what a "schema" is, or how to tell you "47 records were added and the schema gained a field."

**Hugging Face** stores datasets as downloadable artifacts. You version files, you download the whole thing, you process it locally. There is no record-level API, no schema-level diffing, no way to ask "what changed since version 12." It is optimized for the ML pipeline: download and train. Not for incremental access or structured exchange.

**Dat** (now Hypercore Protocol) got the philosophy right: data should be versionable, verifiable, and shareable without trusting the host. Append-only logs, content addressing, cryptographic integrity. But it versions opaque blobs and files. There is no concept of a record or a schema. It solved the transport and integrity layer. Underlay solves the data model and meaning layer.

Underlay treats the typed record as the primitive. That is the difference that matters. Because the record is the unit, you get record-level diffs, schemas you can inspect and compare across collections, and incremental pull: just the changes, not the whole dataset again.

## The protocol

Underlay is a simple HTTP protocol. The operations:

- **Push** JSONL records and a JSON Schema to a collection endpoint. Get back a version number, a semver, and a content hash.
- **Pull** a specific version: its records, its schema, its metadata.
- **Diff** any two versions: which records were added, updated, removed. Which schema fields changed.
- **Fork** a collection and track lineage. The fork relationship is recorded; diffs work across forks.

The protocol speaks JSONL: one record per line, streamable, independently hashable. If your data starts as CSV or parquet, convert at the edges. The protocol stays simple.

Records and schemas are content-addressed. Identical records produce the same hash regardless of which collection or version they belong to. This means storage is deduplicated, push and pull only transfer what the other side does not already have, and provenance (where was this record first seen, who else has it) emerges from the data model for free.

## The server

The protocol is simple. The engineering is in making it work at scale: large pushes via resumable upload sessions, large files via content-addressed object storage, fast diffs over millions of records, concurrent writers via optimistic locking.

The complexity lives behind the API surface. The actor pushing data does not need to think about any of it. If solving a scaling problem would require the pusher to understand how the system stores things internally, the complexity is in the wrong place.

The reference implementation is open source. Anyone can deploy an Underlay server. The protocol is the contract; the implementation is one way to fulfill it.

## The CLI

A local workflow for preparing, validating, and syncing data:

```
underlay init my-collection
underlay schema set schema.json
underlay add records.jsonl
underlay status
underlay commit -m "initial load"
underlay push
```

The CLI wraps the same versioning logic as the server: hashing, diffing, semver derivation. Versions exist locally. You can commit multiple times before pushing, inspect your version history offline, diff locally, and push when ready. Pull works in reverse: fetch versions from a remote, store them locally, push to a different remote if you want.

The CLI is also where format conversion lives. `underlay import data.csv --schema schema.json` reads a CSV and produces Underlay records. `underlay export --format parquet` goes the other direction. The protocol speaks JSONL natively; the tooling meets people where their data already lives.

## underlay.org

The canonical hosted instance: where public collections live, where you discover and collaborate over shared data.

- `/` introduces what Underlay is and why it matters.
- `/docs` covers how to use it.
- `/protocol` documents the protocol: inputs, outputs, behavior. Written as documentation of what the system does, clear enough that someone could build a second implementation from it.
- Collections live at `underlay.org/your-org/your-collection`.
- The API is at `underlay.org/api`.

The protocol and the platform are one story. If demand for a second implementation emerges, the protocol docs are ready. Until then, it is one project, one site, one thing to explain.

## Collaboration

The collaboration model borrows from git but adapts to how data sharing actually works.

The protocol provides three primitives:

- **Forks.** Take a collection, push your own versions of it. The fork relationship is tracked.
- **Diffs.** Compare any two versions, including across forks. "Here is what my fork added relative to your version 47."
- **Lineage.** Every version references what it was based on, creating a directed graph of provenance.

The social layer, contribution proposals, review, discussion, discoverability, lives on underlay.org. A contribution is a fork plus a diff plus a message: "I added 500 records to your dataset, here is what changed." The maintainer reviews the data and accepts or rejects it. This is the pull request pattern, adapted for data instead of code.

For agents, the version history is the audit trail. Every version records who pushed it and what changed. If you want human review before changes go live, the agent pushes to a fork and a person decides whether to merge it upstream.

## The argument

Public knowledge should be a public resource: structured, versioned, and accessible. Previous attempts to build this required agreement before contribution, and that coordination problem killed them.

Two things changed. LLMs can now handle schema alignment dynamically, so you do not need upfront agreement. And content addressing means that independent convergence on the same structure is automatically recognized: same records, same hash, same schema, same type.

Underlay does not need to be smart. It needs to be reliable, durable, and clear. Push what you have. It gets a permanent address. Anyone can point to it, build on it, or align it with something else. The intelligence lives in the actors. The infrastructure holds the pieces.
