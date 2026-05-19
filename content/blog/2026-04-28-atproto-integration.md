---
title: 'Underlay Meets AT Protocol'
subtitle: 'Every collection is a feed. Every push is an event.'
date: 2026-04-28
---

AT Protocol is a federated networking protocol built around typed records, content addressing, and the separation of data from applications. Those are also the design principles behind Underlay. The overlap is not superficial. The two systems solve different problems in complementary ways, and connecting them is straightforward.

Underlay stores immutable, versioned snapshots of structured data. AT Proto streams live changes across a federated network of servers. One is an archive. The other is a wire. Together they give a collection both permanence and real-time distribution.

## How the pieces fit

An Underlay collection is a sequence of versions. Each version contains a JSON Schema, a set of typed records, and references to content-addressed files. An AT Proto repository is a set of typed records organized by lexicon, stored on a Personal Data Server and replicated across a relay network.

The mapping between them is direct. Each Underlay record type becomes a lexicon. Each record becomes a document in the corresponding lexicon collection. The collection's JSON Schema and AT Proto's Lexicon format are structurally similar enough that conversion is mechanical for the common cases.

```
Collection: knowledge-futures/pubpub-archive

Record types → Lexicons:
  Community → org.underlay.kf.pubpub-archive.community
  Pub       → org.underlay.kf.pubpub-archive.pub
  Author    → org.underlay.kf.pubpub-archive.author
```

When a new version is pushed to Underlay, a bridge diffs it against the previous version and writes the changes to a PDS as a batch of creates, updates, and deletes. AT Proto clients subscribed to that repository see the new records immediately.

Going the other direction: the bridge subscribes to a PDS firehose, watches for records matching specific lexicons, and periodically pushes snapshots to an Underlay collection. The live working data flows through AT Proto. The versioned, immutable archive lives in Underlay.

## What each side gains

AT Proto repositories are mutable. Records can be updated or deleted. Accounts can disappear. There is no built-in concept of versioning or historical snapshots. Underlay provides that layer. If you need to verify what was published and when, or reconstruct the state of a dataset at a specific point in time, the Underlay collection is the authoritative record.

Underlay collections are accessible through a REST API. You poll for new versions. There is no push notification, no subscription, no real-time stream. AT Proto provides that layer. A collection connected to AT Proto becomes a live feed that any PDS can relay and any client can follow. The data reaches readers without them needing to know about the Underlay API.

## Concrete examples

A research lab runs a PDS using custom lexicons for their experimental data and publications. The bridge watches their repository and pushes daily snapshots to `mylab/datasets` on Underlay. The PDS is the lab's active workspace. The Underlay collection is the permanent, citable archive.

A journal pushes article records to Underlay through its publishing platform. The bridge writes each new article to a PDS. The journal's output is now part of the AT network, discoverable in any client that understands the lexicon. A Bluesky user can follow the journal's DID and see new articles in their feed alongside social posts.

A library wants to preserve a set of public collections. It runs its own Underlay instance and mirrors them. It also subscribes to the AT Proto relays for those accounts and indexes the firehose for its discovery interface. Same data, two access patterns: archival via Underlay, real-time via AT Proto.

## Identity

Every Underlay account maps to a DID. The natural choice is `did:web`, which resolves to a URL the account already has:

```
did:web:underlay.org:knowledge-futures
```

Any AT Proto client that encounters this DID can resolve it, fetch the repo, and subscribe. No registration on a separate service is needed. The identity is derived from the Underlay account.

On collection pages, we show the `at://` URI alongside the existing API endpoints. If you have an AT Proto client, you can paste the URI and subscribe. If you do not, the REST API and export remain available.

## What we are building

The first step is identity: resolving `did:web` for Underlay accounts and serving the discovery documents that AT Proto expects. The second step is outbound sync: watching for new versions and writing diffs to a PDS. The third step is inbound sync: subscribing to external PDS firehoses and pushing snapshots to Underlay.

The archive underneath your app can also be the feed inside your network.
