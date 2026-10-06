# v1 read API: what v2 must match

An inventory of v1's read endpoints (repo root `src/api/*`) and what the existing React UI
(`src/routes/**/*.data.ts`, `src/components/*`) actually reads, for the v2 read path. It was
taken from `main` at `7f6e1c6` on 2026-10-03.

Within each section, "Response" is the shape and "UI reads" is what the UI uses. Where they
differ, only the UI fields are essential.

## Cross-cutting

- **Errors**: `{ error, statusCode }`. Uncaught errors give 500 `Internal server error`.
- **Missing vs hidden**: an invisible collection returns 404 `Collection not found`, the same as
  a nonexistent one.
- **Auth, in order**:
  - `Authorization: Bearer <key>`: an invalid key is 401;
  - `?token=<key>` on GET/HEAD: invalid falls back to anonymous;
  - the session cookie;
  - anonymous for GETs.
- **Scope**: `permissions.collections` (admin > write > read). `metadata.collectionIds` limits a
  key to those collections.
- **Owner access** means org membership, and a key's collection list (if any) covering the
  collection. **Visible** means public or owner.
- **Rate limit**: a 60 s window. 60 requests per IP when anonymous, 5,000 per user. Sends the
  `X-RateLimit-*` headers; over the limit, 429 with `Retry-After`.
- **Semver params** accept `1.0.0`, `v1.0.0` or `1`. They're stored as `v1.2.3`.
- **Share links**:
  - A view link is a read key with `{scope:'read', collectionIds:[id], linkShare:true}`, valid 30
    days, used as `/<owner>/<collection>?token=ul_…`.
  - An agent link is a 1-hour write key at `/agent/<key>`, which serves an HTML page.
  - The UI builds API URLs with `apiUrlBuilder`, which forwards `?token=`.

## SSR context

`GET /api/context` uses the session cookie only and never returns 401.

```ts
{ currentUser: null | { id, slug /*default org*/, displayName, avatarUrl, kfRole,
    defaultOrg: {slug, displayName} | null,
    orgs: [{ organizationId, slug, displayName, role, isDefault }] },
  mirrorConfig: { enabled, upstream, nodeName, syncSchedule },
  kfAccountUrl, kfAuthUrl }
```

- **UI reads**:
  - `currentUser.id/slug/displayName/avatarUrl/kfRole/orgs[].slug/isDefault`;
  - `isOwner` = `kfRole==='admin' || slug===owner || orgs.some(o => o.slug===owner)`.
- **SSR fetches** go to `http://127.0.0.1:${PORT}` (`fetchBase`). On Workers they must go
  in-process (build doc finding 9).

## Collections

**`GET /api/collections`**

- **Query**: `q`, `owner`, `tag`, `sort` (`name`, `records`, `featured`, or default updatedAt),
  `mine=true` (needs a session), `limit` (≤100, default 50), `offset`.
- **Response**:
  ```
  { collections: [{ id, slug, name, public, ownerSlug, ownerName, createdAt, updatedAt,
      description, tags, latestVersion /*semver*/, recordCount, fileCount, totalBytes, lastPushAt }],
    facets: { owners: [{slug,name,count}], tags: [{name,count}] },
    featuredTags: string[], featuredCollections: [same item] }
  ```
- **UI reads** (explore and dashboard): `ownerSlug, slug, name, public, description, tags,
latestVersion, recordCount, totalBytes, lastPushAt, updatedAt`, plus the facets and featured
  fields.
- **v1 bugs**: sorting, tag filters and facets run in memory over a window. The home page reads
  `semver`, which doesn't exist.

**`GET /api/collections/:owner/:slug`**

- **Response**:
  ```
  { id, slug, name, public, ownerSlug, ownerName, createdAt, updatedAt, description, ark,
    versionCount, latestVersion: null | { semver, hash, message, metadata, appId, pushedBy,
    baseSemver, recordCount, fileCount, totalBytes, createdAt, typeCounts: [{type,count}] } }
  ```
- **UI reads**:
  - collection fields: `public, id, ownerSlug, ownerName, description, versionCount, ark, name,
slug`;
  - version fields: `latestVersion.semver`, `.metadata.readme/description/tags`, and the
    overview's `semver, recordCount, fileCount, totalBytes, createdAt, typeCounts` (array or
    object), `message, baseSemver, appId, pushedBy, hash`.
- Non-owners lose `pushedBy/actorId/signature` and private types in `typeCounts`.

**`GET /api/accounts/:owner/collections`**

- **Response**: `[{ id, slug, name, public, createdAt, updatedAt }]`. Members also see private
  collections; an unknown org gives `[]`.

**`GET /api/collections/:owner/:slug/export?version=v1.2.3`**

- Returns `<owner>-<slug>-<semver>.tar.gz` containing:
  - `manifest.json`: `{collection:{owner,slug,name,description}, version:{semver,hash,message,recordCount,fileCount,totalBytes,createdAt}, schemas, files_missing}`;
  - `records/<Type>.ndjson`;
  - `files/<hash>`.

## Versions

**`GET .../versions?limit&offset`**

- **Response**: a bare array, newest first:
  `[{ semver, hash, message, appId, actorId? (owner), recordCount, fileCount, totalBytes, createdAt, ark }]`.
- **UI reads**: `semver, message, recordCount, fileCount, totalBytes, createdAt, hash, ark`. The
  version picker uses `?limit=20` and accepts an array or `{versions}`.

**`GET .../versions/latest`, `GET .../versions/:n`**

- **Response**:
  ```
  { semver, major, minor, patch, hash, baseSemver, message, metadata, pushedBy, appId, actorId,
    recordCount, fileCount, typeCounts: {type: n}, totalBytes, createdAt,
    schemas: { slug: JSONSchema }, ark }
  ```
- **UI reads**: `semver, schemas` (its keys, and `[t].properties` for table columns),
  `recordCount, fileCount, totalBytes, createdAt, appId, hash, ark, message, metadata,
typeCounts, baseSemver, pushedBy`.

**`GET .../versions/:n/records?type&limit(≤2000, default 100)&offset(≤10000)&after|cursor`**

- **Response**:
  `{ records: [{ id, type, data, hash, ark? }], pagination: { limit, hasMore, nextCursor, total } }`.
- **Cursor**: `base64url(JSON {r:[recordId, recordHash]})`, or a bare id.
- **UI reads**: `records[].id/.data/.hash/.ark` and `pagination.total`. The UI pages by offset;
  past offset 10k, v1 answers 400.

**`GET .../versions/:n/records.ndjson?type&after`**

- Lines are `{id,type,data,hash}`. `X-Underlay-Record-Count` gives the total. Gzip is applied
  when accepted.

**`GET .../versions/:n/files`**

- **Response**: a bare array, `[{ hash, size, mimeType, createdAt, references: [{recordId,type,field}] }]`.
- **UI reads**: `hash, mimeType, size, references[].type/.recordId`.

**`GET .../versions/:n/manifest?since&limit(≤100k)&cursor`**

- **Full**:
  `{ semver, hash, schemas: {slug: schemaHash}, records: [{id,type,hash,private?}], files: string[], pagination }`.
- **Delta**:
  `{ semver, hash, since, schemas, delta: {added, updated (+previousHash), removed}, files, pagination, truncated }`.
- Used by the CLI pull and mirror sync, not the UI.

**`GET .../versions/:n/diff?from&limit(≤5000)&cursor`**

- **Response**:
  `{ from, to, added: [{id,type,data}], updated: [{id,type,data}], removed: string[], pagination, meta: {schemaChanged, metadataChanged, filesAdded, filesRemoved} }`.
- **UI reads**: `added, updated, removed, meta.*`. It also reads `meta.readmeChanged`, which v1
  never returned.

## Schemas

- **`GET /api/schemas?q|label|slug|schema_hash&limit&offset`**
  - Returns `[{ id, schema, schemaHash, createdAt, labels: string[] }]`. With `schema_hash` it
    returns one object plus `usageCount`.
  - A schema is visible when it's non-private in a public collection, or in one of the caller's
    orgs.
- **`GET /api/schemas/:id`**
  - Returns
    `{ id, schema, schemaHash, createdAt, labels: [{label, createdAt}], usage: [{slug, semver, collection: "owner/slug"}] }`.
- **`GET /api/collections/:owner/:slug/schemas?version&raw`**
  - Returns
    `{ version, semver, schemas: [{ slug, schemaId, schemaHash, schema (+ 'x-underlay-labels') }] }`.

## Records, files, accounts

- **`GET /api/records/:hash/provenance`**
  - Returns
    `{ hash, recordId, type, data, size, createdAt, firstSeen, references: [{owner, collection, collectionName, semver, versionCreatedAt}] }`.
  - References are public collections only.
- **`POST /api/records/batch`**: `{hashes}` in, NDJSON out.
- **Files**:
  - `HEAD|GET /api/collections/:owner/:slug/files/:hash`: GET is a 302 to a presigned URL with
    `attachment`.
  - `GET /api/collections/files/:hash`: the same, for any collection the caller can read.
  - `POST .../files/presign {hashes}` returns `{hash: url|null}`.
- **Accounts**:
  - `GET /api/accounts/:slug` returns the org row, plus `displayName` and `arkShoulder`.
  - `GET /api/accounts/:slug/members` returns `[{role, slug, displayName}]`.
  - `GET /api/accounts/me` returns
    `{id, name, email, image, slug, displayName, createdAt, orgs:[{organizationId, role, slug, name, isDefault}]}`.
- **ARK**:
  - `GET /api/ark/resolve?path=ark:…` returns `{type:'redirect', url, metadata}`, or 404
    `{type:'not_found'}`.
  - `GET .../ark` returns `{enabled, customUrl, arkUrl, shoulder, arkId}`.
  - `GET .../ark/record-types` returns `[{recordType, redirectUrlField}]`.
- **Webhooks**:
  - `GET .../webhooks` returns
    `{webhooks:[{id,url,bumpFilter,enabled,createdAt,lastDeliveryAt}]}`.
  - `GET .../webhooks/:id/deliveries` returns `{deliveries:[…]}`.
- **Health**: `GET /api/health` returns `{status:'ok', timestamp}`.
- **KF summary**: `GET /api/kf/summary?kf_org_id`, with the KF internal key, returns per-org
  collection stats.

## v1 behaviour v2 deliberately changes or fixes

- **Records order**:
  - With `?type=`, records are in id order.
  - Without it, they're in (type, id) order, and the cursor becomes (type, id) (edge-redesign.md
    Read path).
  - Offsets have no 10k cap: they cost O(height) in v2.
- **Non-owner hashes and counts**:
  - Non-owners get the public set's real contents, and its counts are exact, not upper bounds.
  - A version's `hash` is the v2 version hash for everyone. There's no separate public hash.
- **Field-level privacy is gone**, so nothing is stripped from records.
- **Manifest `files` and version `/files`** come from the set's file tree and are
  privacy-correct. The manifest lists files on its first page only, at most 25,000, then
  `filesTruncated: true`; `/files` returns at most 10,000, with `references` always `[]` and a
  `referenceCount`.
- **Inconsistent v1 fields** (`typeCounts` array vs object, `labels` list vs objects) are kept
  where the UI depends on them.
- **Auth**: an invalid `?token=` is a 401, as a Bearer key is; it no longer falls back to
  anonymous. Org-owned keys spend their org's rate budget.
- **Rate limits**: no `X-RateLimit-*` headers; a 429 has `Retry-After: 60`. Anonymous pages
  (ARK resolution and `/api/auth/*` included) have their own budget of 600 a minute per IP, and
  expensive reads cost more than one unit (`packages/server/src/lib/limits.ts`).
- **Version params** also accept a `ulv2:` version hash.
- **`/api/context`**: no `mirrorConfig`; adds `siteHost`. Server-rendered pages call the API
  in-process on both runtimes.
- **Records**: no per-record `ark`; members' private records carry `private: true`.
- **records.ndjson**: no server-side gzip. `?after_type=T&after=id` resumes after (T, id)
  through the later types; `?type=T&after=id` stays within T; `after` with neither, or
  `after_type` without `after`, is a 400. `X-Underlay-Record-Count` counts what the request
  returns, after the resume point. Members' private lines end `"private":true`.
  `records.ndjson.gz?type=` is new (one type's public records as stored).
- **Manifest**: the default limit is 10,000 and the maximum 25,000; no `truncated` field; delta
  `removed` entries are `{id, type, hash}`. For members, delta entries in the private set carry
  `private: true`, and a move between sets is under `updated` with `previousPrivate` (with
  `previousHash` equal to `hash` when the record didn't change).
- **Diff**: without `from`, the diff is against the version before (the first version's is
  against nothing); `removed` entries are `{id, type}`, not bare ids.
- **Provenance**: covers the caller's own organizations' collections as well as public ones,
  adds `recordHash`, and is capped at 300 presences and 100 versions per collection.
- **`POST /api/records/batch`**: 1 to 100 hashes.
- **Export**: `?format=tar|tar.gz`; `manifest.json` adds `files_withheld`, and `README.md` is
  included when the metadata has a readme. Tar entries carry the version's creation time, so a
  version exports to the same bytes every time.
- **Health**: `{ok: true, version: 2, deployment, time}`.
- **Agent links**: `GET /agent/<key>` is ported. It serves the HTML instructions page for the
  share panel's 1-hour, one-collection write key, now describing delta push; a key that isn't
  such a live key gets a 404 page.
