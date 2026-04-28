---
layout: ../../layouts/BlogPost.astro
title: "The IR of the Future Is a Reading List"
subtitle: "Institutional repositories don't need to be monoliths. They need to be views."
date: 2024-04-27
---

Every university has an institutional repository. The software varies (DSpace, EPrints, Digital Commons) but the architecture is remarkably consistent. The IR defines a data model, usually Dublin Core or a local extension of it, provides a submission workflow where researchers upload a PDF and fill in metadata fields, stores everything in its own database and filesystem, and renders a search interface on top. The backend, the data structure, and the UI are all one application. You cannot swap the frontend without rebuilding the system. You cannot access the data except through the application. Connecting two IRs requires a harvesting protocol like OAI-PMH, designed in 2002 and showing its age.

Most IRs are underused. The issue is not software quality but the workflow they impose. A researcher submits a paper to a journal, posts a preprint, pushes a dataset to a domain repository, and then the library asks them to deposit the same work again in a different interface with different metadata fields. It is a second publication step that benefits the institution's record-keeping but not the researcher's work. Compliance rates reflect this.

## The IR as a view

We think a different architecture is possible now, one that separates the institutional repository from the data it presents.

When structured data is published to Underlay collections (versioned, schema-described, content-addressed) the research output already exists in a durable archive before the IR enters the picture. A lab pushes its datasets to a collection. A journal pushes its articles. A research group maintains a collection of working papers. The data is already preserved, structured, and accessible via API.

An institutional repository does not need to be the place where data lives. It becomes a curated list of collections affiliated with the institution, presented through a unified interface. The IR reads from these collections. It does not ingest, re-process, or re-store their contents. Researchers continue pushing to their collections through whatever tools they already use. The IR watches those collections and reflects their contents automatically.

## What the IR does instead

When the IR is no longer responsible for storage and submission, its role becomes more focused.

The primary job is curation: deciding which collections represent the institution's output. A new faculty member arrives; the library adds their collection. A research center launches; its collection gets included. This is editorial work, the kind of judgment librarians already exercise in collection development.

The second job is presentation. Different collections have different schemas. A chemistry lab's experimental records look nothing like an economics department's working papers. The IR needs to present these coherently: faceted search, department pages, author profiles. Given a collection's JSON Schema and a target display model, a language model can generate the mapping between them. The alignment happens in the view layer, not in the data, which means no one has to agree on a universal metadata standard ahead of time.

The third job is institutional policy. The IR can enforce requirements (all affiliated collections must be public, the library mirrors them for preservation, version pushes must happen at least annually) without owning the underlying storage. These are policies applied to a list of references, not constraints embedded in a monolithic application.

## What changes for whom

For researchers, the workflow stays the same. They publish through whatever tool they use. Their work appears in the IR because the IR is watching their collection.

For librarians, the work shifts from system administration and deposit compliance toward collection curation and policy.

For the institution, the IR becomes a lightweight frontend that reads from an API rather than maintaining its own storage and migration infrastructure. If the institution wants to change how the repository looks, that is a frontend project. The data does not move.

For the broader ecosystem, the data is not locked inside the IR. Other institutions can read the same collections. Aggregators can pull from them directly. The institutional view is one of many possible views over the same underlying data.

## In practice

The IR maintains a list of collection references: pointers like `knowledge-futures/ameriquests` or `jsmith-lab/crystallography-2026`. A sync process periodically reads new versions from each affiliated collection via the Underlay API. Records are pulled into a local index for fast search, organized by whatever facets the institution cares about. A frontend renders the index.

The IR is a reader, not a writer. Versioning, preservation, schema validation, file storage, deduplication: all handled by Underlay. The IR is concerned with presentation.

## The deposit problem

The persistent failure of institutional repositories has been adoption. The literature is full of studies on deposit rates, analyses of mandate effectiveness, proposals for making submission less painful. The assumption is always that researchers need to be persuaded or required to put their work in the repository.

But the deposit problem is an artifact of the architecture. When the IR is a separate storage system with its own submission workflow, depositing is inherently extra work. When the IR is a view over collections that researchers are already pushing to, there is nothing to deposit. The work appears because the data already exists in a place the IR can read.

## Prerequisites

Researchers and their tools need to be pushing structured data to Underlay collections. This is not a requirement specific to IRs; it is the general Underlay adoption story. Every journal platform or lab notebook that integrates with Underlay makes institutional repositories better as a side effect.

It depends on language models being reliable enough to align heterogeneous schemas at the view layer. Given where models are today, this is reasonable. The alignment does not need to satisfy a deep ontological standard. It needs to produce a coherent search result page.

And it depends on institutions becoming comfortable with the idea that preservation does not require owning a copy of every record in their own database. When collections are versioned, immutable, content-addressed, and replicable, preservation can mean mirroring affiliated collections to a local Underlay instance. That is more robust than what most IRs provide today.

## A reading list, not a database

The institutional repository we are describing is a curated reading list backed by a public, structured archive. The library decides what belongs on the list and sets policy around it. The researcher does their work and pushes it to a collection. The infrastructure connects the two.

Institutional repositories were always meant to make a university's knowledge accessible. They ended up becoming another silo that knowledge had to be manually deposited into. The better path is to make the knowledge accessible first, structured and versioned and public, and let the institution put its frame around it.

*Underlay is a public registry for structured knowledge. An institutional repository is one way to read it.*
