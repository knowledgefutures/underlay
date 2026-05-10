---
title: "From Monolithic Schemas to Content-Addressed Types"
subtitle: "How we made interoperability automatic by treating schemas like files."
date: 2026-04-30
---

When we first built Underlay's versioning system, each version stored a single JSON Schema document describing all its record types. It worked fine. Records got validated, types got declared, the system moved forward. But once we started thinking about cross-collection interoperability (what happens when two organizations independently publish the same kind of data?) the limitations showed up fast.

This post walks through what we started with, why it fell short, and what we replaced it with.

## The original approach: one schema per version

The first implementation stored a monolithic JSON Schema on the `versions` table as a JSONB column:

```json
{
  "type": "object",
  "properties": {
    "Author": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "email": { "type": "string" },
        "orcid": { "type": "string" }
      }
    },
    "Publication": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "doi": { "type": "string" },
        "publishedAt": { "type": "string", "format": "date-time" }
      }
    }
  }
}
```

One document per version, embedded directly in the row, describing every record type. Push scripts sent the whole thing each time (or omitted it to carry forward). Validation extracted the sub-schema for each record type and ran it through AJV.

Simple, functional. Three problems.

## Problem 1: alignment requires extraction and comparison

Say a researcher publishing Authors wants to check whether their Author type matches another collection's. The system has to:

1. Fetch both monolithic schemas
2. Extract the `Author` sub-schema from each
3. Normalize the JSON (key ordering, whitespace)
4. Compare them

There's no way to answer "who else uses this exact Author shape?" without scanning and parsing every collection's schema. That query is O(n) in the number of collections. You want it to be O(1).

## Problem 2: no reuse, no deduplication

If 50 collections all define the same Author type (same fields, same types, same constraints) that's 50 copies of the same JSON in 50 different documents. The system can't tell they're the same. No shared identity, no hash to compare against.

Interoperability should be automatic. If you independently arrive at the same type definition as someone else, you should be aligned without either party knowing the other exists. That's how content addressing works for files. It should work for schemas too.

## Problem 3: AT Proto doesn't work this way

AT Protocol uses Lexicons: per-type schema definitions that are globally namespaced and independently versioned. A Lexicon for a post type is separate from one for a profile type. They compose but don't nest. Our monolithic schema has no natural mapping to that model, and AT Proto integration is on our roadmap.

## The new approach: schemas as global, content-addressed entities

We treat schemas exactly like we treat files: content-addressed, globally deduplicated, immutable, referenced by versions rather than owned by them.

### Two new tables

```sql
-- Global schema store (one row per unique schema body)
CREATE TABLE schemas (
  id           uuid PRIMARY KEY,
  schema       jsonb NOT NULL,
  schema_hash  text UNIQUE NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Which types a version uses, with explicit schema bindings
CREATE TABLE version_schemas (
  version_id   bigint REFERENCES versions(id),
  slug         text NOT NULL,
  schema_id    uuid REFERENCES schemas(id),
  PRIMARY KEY (version_id, slug)
);
```

`schemas` is a global, append-only store. Each row holds one JSON Schema body and its SHA-256 hash. If two collections define identical type shapes, they produce the same hash and point to the same row. Alignment falls out of the data model rather than being a feature you build on top.

`version_schemas` is the explicit declaration: "version N uses types A, B, C, each bound to a specific schema." Every version has a complete set of rows. No walking backwards through history to figure out what a version supported.

### Push payload

```json
{
  "schemas": {
    "Author": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "email": { "type": "string", "private": true },
        "orcid": { "type": "string" }
      }
    },
    "Publication": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "doi": { "type": "string" },
        "authorId": { "type": "string", "x-ref-type": "Author" }
      }
    }
  },
  "changes": { "added": [...] }
}
```

Instead of a nested document-within-a-document, schemas are a flat map of type name to type schema. Each type's schema is independently hashed and stored. The push logic hashes each body, upserts into the global table (gets the existing row if the hash matches), then writes `version_schemas` rows linking this version to those schema IDs.

### Interoperability becomes a query

"Who else uses this exact Author schema?" is now:

```sql
SELECT c.slug, a.slug as owner
FROM version_schemas vs
JOIN versions v ON vs.version_id = v.id
JOIN collections c ON v.collection_id = c.id
JOIN accounts a ON c.account_id = a.id
WHERE vs.schema_id = $1 AND c.public = true;
```

One indexed lookup. No parsing, no diffing, no scanning.

### Relationship annotations

Our records are flat JSON with relationships expressed as string IDs. We added a lightweight `x-ref-type` annotation to document these:

```json
{
  "authorId": { "type": "string", "x-ref-type": "Author" }
}
```

This tells the system that `authorId` holds record IDs of type `Author` in the same collection. It's just a property on the JSON body that gets included in the hash, but it lets the UI render clickable links between records and gives LLMs the relational graph without guessing from field names.

We considered JSON Schema's `$ref`/`$id` for this, but our records are flat (no nested objects to compose) and `$ref` introduces real complexity: resolution logic, circular dependency detection, hash instability when referenced schemas change. `x-ref-type` does what we need without any of that.

## Schema labeling

Content addressing gives us identity and deduplication. But hashes aren't human-readable. When a particular Author schema is used by dozens of collections, it's useful to give it a name.

Rather than requiring names upfront (coordination problem), we let names emerge through post-hoc labeling:

```
POST /api/schemas/:id/labels
{ "label": "schema.org/Person" }
```

A schema can have many labels. Labels can be URIs, short names, whatever the community converges on. When schemas are exported, their labels are injected as `x-underlay-labels` so consumers can see what standards a schema corresponds to.

The ordering matters: structure first, names later. Collections don't need to agree on a name before they can be aligned. They just need to independently arrive at the same shape. The name comes after, as recognition of what already happened.

## Privacy

The privacy system carries over unchanged. Type-level privacy (`"private": true` on the schema), field-level privacy (`"private": true` on a property), and record-level privacy (a boolean column on the record row) all work the same as before. The annotations live inside the schema JSON body, so they're part of the hash. Two collections with identical structure but different privacy settings produce different hashes, which is correct since their public API surface is different.

## Versioning semantics

With per-type schemas, semver derivation is more precise:

- **Major**: Any type's schema changed (different hash), or a type was added/removed
- **Minor**: Records changed, schema set identical
- **Patch**: Only metadata changed (readme, message)

Adding a new type bumps major (new schema). Modifying an existing type bumps major (hash changed). Adding records to existing types bumps minor. Maps cleanly to what consumers care about: did the contract change?

## What this enables

The immediate result is that schema alignment across collections is free. But the architecture also opens up a few things we plan to build:

**Standards as collections.** Import schema.org, Dublin Core, or any taxonomy as an Underlay collection. Their type schemas get hashed and stored. Any collection that independently uses the same shape is discoverable via one query.

**Near-alignment detection.** When schemas don't match exactly, structural comparison can show how close they are. "Your Author type matches schema.org/Person except for two extra fields" is a useful signal.

**AT Proto bridging.** Each type schema maps cleanly to a Lexicon definition. The bridge can generate lexicons from Underlay schemas mechanically.

## Takeaway

The original monolithic schema wasn't wrong. It solved validation, which was the immediate need. But it made discovery and interoperability expensive. The fix wasn't adding a discovery layer on top. It was changing the data model so that discovery is a natural consequence of how things are stored.

Content addressing is the key insight, same as with file deduplication: if the content is the identity, then independent convergence on the same structure is automatically recognized. No coordination required.
