---
title: 'Underlay, Revived'
subtitle: 'The landscape changed. The project can finally be simple.'
date: 2024-04-27
---

In 2018, we started the Underlay as a research project at MIT. We wanted to build a global, distributed graph of public knowledge: a decentralized knowledge base aggregating machine-readable assertions with their provenance, contestations, and chains of sourcing. We talked about IPFS-backed federation, RDF-style linked data, universities maintaining full nodes.

The problems we identified were real. Public knowledge was (and still is) locked in proprietary formats, trapped in platform silos, stripped of context, inaccessible to machines. Structured public data with provenance, versioned over time, accessible to anyone: those remain the right things to want.

But the system we designed tried to solve alignment, trust, provenance, federation, querying, and hosting all in a single protocol layer. The project ended up perpetually in "Phase 1." Technically interesting, architecturally considered, not yet useful to anyone who just needed to publish and preserve their work.

We are reviving Underlay now because the landscape shifted in a way that makes the simple version viable, and sufficient.

## What changed

Three things, each removing a class of complexity the original design had to absorb.

**Building custom software got fast.** In 2018, the only realistic way to support diverse publishing workflows was to build a platform. One large application with toggles and settings for every use case. That is why we built PubPub: a shared platform for journals, books, reports, and research.

That is no longer true. With modern tooling and AI-assisted development, a bespoke publishing application with custom workflows and a tailored editorial process can be built in a fraction of the time and cost. Better for the user: they get exactly the tool they need.

But if the application is bespoke, and perhaps even disposable, the _data_ needs to live somewhere durable. The application is the interface; the archive is the thing that lasts.

**LLMs changed what "interoperability" requires.** The original Underlay spent enormous effort on alignment: reconciling schemas, mapping ontologies, resolving entity references across datasets. This was genuinely hard when the consumer was a rigid program that needed exact field names and precise types.

If structured data is published with a clear schema, a language model can map between schemas, translate formats, and generate integration code on the fly. The interoperability problem moved from "must be solved in the protocol" to "can be solved at the application layer, on demand." The infrastructure needs to provide structure and clarity. The rest can be handled dynamically.

**We learned from running PubPub for seven years.** What publishers and researchers actually need is not a knowledge graph. It is a reliable, versioned archive of their work that survives independently of whatever tool they use today. If the application goes away, the data is safe. If they want to switch tools, they can. If someone wants to verify what was published and when, the record exists.

The goal was always the same: make structured public knowledge accessible. What changed is that we no longer need a single coherent graph designed from the top down. Publish structured data with clear schemas and a useful knowledge graph can be assembled from the bottom up, by the tools and models that consume it. The infrastructure just needs to hold the pieces clearly.

## What Underlay is now

Underlay is a versioned registry for knowledge. The closest analogy is npm for data, or Docker Hub for structured content.

You have a knowledge tool: a journal platform, a peer review system, a dataset manager, a research archive. Your application has a database. Periodically, it pushes a snapshot of its current state to Underlay. That snapshot includes:

- A **JSON Schema** describing the shape of the data
- A set of **flat JSON records**: the actual content
- **Files** (PDFs, images, datasets): content-addressed by hash, stored once, referenced by records
- **Metadata**: who pushed this, when, from which application, with what message

Each snapshot is a **version**. Versions are immutable and sequential. You can browse any version, diff between versions, export the full history. The schema can change between versions; each version is self-describing.

No knowledge graph. No RDF. No custom query language. No consensus protocol. Structured data, versioned over time, with files, served over a simple HTTPS API.

## What we dropped

**The global knowledge graph.** The original Underlay imagined a single interconnected graph of all public knowledge. In practice, knowledge is produced in bounded contexts: a journal, a lab, a dataset, an institution. Underlay now stores these as independent **collections**, each with its own schema. Cross-collection linking and alignment happen at the application layer, handled by tools or language models that read from multiple collections. Alignment no longer needs to be baked into the protocol for the data to be useful.

**RDF and linked data.** We used RDF-style triples and named graphs because they were the most expressive way to represent arbitrary knowledge with provenance. But expressiveness came at the cost of accessibility. Almost no one outside the semantic web community produces RDF natively. JSON Schema and flat JSON records cover the vast majority of real-world publishing data, are understood by every developer and every language model, and map trivially to and from SQL databases.

**Deep provenance.** The original vision tracked provenance at the assertion level: who said this, who published it, who contested it. The cost of maintaining that granularity is prohibitive for most publishers. Underlay now tracks provenance at the version level: which application pushed this snapshot, when, with what actor ID and message. Applications can embed richer provenance in their records if they want. The registry does not interpret it. Practices around provenance develop per context and over time, rather than being enforced by the infrastructure layer.

**Federation via protocol.** The original design imagined Underlay nodes at universities syncing via a custom protocol. The new design is simpler: Knowledge Futures hosts the first canonical instance. Others can self-host. Syncing between instances is "give me all versions since N," the same pattern as pulling a git remote. HTTPS and sequential versioning. The architecture supports multiple canonical instances over time, but federation does not need to exist on day one. It just needs to be possible.

## What this gives you

For a single application: a versioned backup of everything it has produced. Full history, portable data. If the application is shut down, the archive survives. Export the collection and go.

For Knowledge Futures: a service alongside custom application development. Every community, client, or project gets a collection. A new engagement means a new application and a new collection, not a new platform instance. We maintain the infrastructure; communities own their data.

For the broader ecosystem: a public registry where anyone can browse, discover, and pull structured knowledge. A researcher finds a journal's full archive. A library mirrors public collections for preservation. A developer builds a new tool that reads from existing collections. A language model reads a collection's schema and records and immediately understands the structure.

## The core of it

The Underlay was always about one thing: public knowledge should be a public resource, structured, versioned, and accessible. The first attempt tried to build the entire stack at once. This version recognizes that we can achieve the same goal with a simple, stable, content-addressed registry. Small API surface. Clear structure. Durable storage.

The hard problems we originally tried to solve in the protocol (alignment, mapping, transformation, discovery) are now better solved by tools and models that sit on top of structured data. The Underlay does not need to be smart. It needs to be reliable, durable, and clear. Get the structure right, make it public, and the rest follows.

_Underlay is a public registry for structured knowledge. The structure is the infrastructure._
