## Migrate to React Router Data Mode

**53 files changed, net -250 lines**

### Summary

Replaces the hand-rolled SSR system (manual route matching, `loaders.server.ts`, `useSSRData` context, `window.__SSR_DATA__` hydration) with React Router v7's Data Mode APIs (`createStaticHandler`, `createBrowserRouter`, `useRouteLoaderData`).

Data Mode is the middle tier of React Router's three modes — it gives us loaders, actions, fetchers, and revalidation without taking over the server or build system. Hono, Vite, and the full `server.ts` are structurally unchanged.

### What changed

**Deleted:**
- `loaders.server.ts` (410 lines) — every loader did the same thing: `getSessionUser(request)` + `getMirrorConfig()` + URL params the component already had via `useParams()`. A single root loader replaces all 39.
- `lib/ssr-data.tsx` — custom React Context for SSR data, replaced by React Router's built-in data flow.

**New:**
- `/api/context` endpoint — returns `{ currentUser, mirrorConfig, kfAccountUrl, kfAuthUrl }`. Used by the root loader during client-side navigations.
- `lib/app-context.ts` — typed `useAppContext()` hook wrapping `useRouteLoaderData('root')`.
- `lib/route-meta.ts` — shared `extractRouteMeta()` used by both entry points for title/description extraction.
- `components/Root.tsx` — invisible root route component (`<Outlet />` + error boundary).

**Rewritten:**
- `entry-server.tsx` — uses `createStaticHandler` + `query(request, { requestContext })` + `StaticRouterProvider`. Passes `loadAppContext` via `requestContext` so the root loader calls `getSessionUser` directly during SSR — no loopback HTTP request. Auth redirects checked via `handle.requireAuth` after `query()`.
- `entry-client.tsx` — uses `createBrowserRouter` + `RouterProvider` with hydration data. Pre-resolves matched lazy routes before `hydrateRoot` to prevent mismatch. Title updates via `router.subscribe()` using shared `extractRouteMeta()`.
- `App.tsx` — pure config: exports a `routes` array with an isomorphic root loader that branches on `context` (SSR: direct server call; client: fetch `/api/context`).
- `route-gen.ts` — new `buildDataRoutes()` that outputs `RouteObject[]` with `lazy` for code splitting. `buildRoutes()` kept for test backward compat.

**All 39 route files:**
- Added `handle` exports for `{ title, requireAuth }` — replaces the title/auth metadata that lived in `loaders.server.ts`.
- Replaced `useSSRData(key)` with `useAppContext()`.
- Auth guards changed from `if (!me) return null` to `<Navigate to="/login" replace />`.

### Why this is worth doing

1. **Client-side navigations now fetch data.** The old `useSSRData()` was a dead-end — it only had data from the initial server render. Navigate to `/dashboard` from `/explore` and `currentUser` was stale. The root loader now runs on every navigation.

2. **Per-route data loading is now possible.** If a route needs to prefetch data (e.g., collection metadata for `/:owner/:collection`), it can export a `loader` and use `useLoaderData()`. The infrastructure is in place without any additional plumbing. Route loaders can use `requestContext` during SSR for direct server access, falling back to API fetches on the client.

3. **Actions and mutations have a path.** `useFetcher()`, `<Form>`, and automatic revalidation after mutations are available. When we add write operations beyond raw `fetch()` calls, we don't need to build the lifecycle ourselves.

4. **Standard APIs.** `createBrowserRouter`, `useRouteLoaderData`, `createStaticHandler` are well-documented, widely used, and what tools/LLMs expect to see in a React Router v7 app.

5. **Convention that scales across projects.** This is the SSR pattern for all KF apps. The hand-rolled approach was ~300 lines of custom plumbing per project (entry-server, loaders, ssr-data, route matching). Data Mode replaces that with a standardized setup backed by React Router's own APIs.

### How SSR data loading works

The root loader is isomorphic — the same function runs during SSR and client navigation — but it branches on whether the server provided a `requestContext`:

```
SSR request → entry-server.tsx
  → handler.query(request, { requestContext: { loadAppContext } })
  → root loader sees context.loadAppContext → calls getSessionUser() directly
  → no HTTP overhead, direct DB access

Client navigation → createBrowserRouter
  → root loader sees no context → fetch('/api/context')
  → normal client-to-server request
```

Per-route loaders follow the same pattern: use `requestContext` for direct server access during SSR, fall back to API fetches on the client.

### Tradeoffs and known rough edges

**Auth is split across two paths.** Server-side: `entry-server.tsx` checks `handle.requireAuth` after `query()` and returns a 302. Client-side: route components render `<Navigate to="/login">`. Same concern, two implementations. The old system had one code path (loader redirects). This is a Data Mode limitation — loaders can't do server-only auth checks and also run on the client.

**Lazy route hydration needs a workaround.** `entry-client.tsx` pre-resolves matched `lazy` routes before calling `hydrateRoot`. Without this, `RouterProvider` renders `null` while lazy modules load, causing a hydration mismatch (content doubling). The fix is correct but non-obvious — it needs a comment and awareness from anyone touching the client entry.

**`currentUser: any` in AppContext.** The old code used `any` everywhere for the user object. The typed `AppContext` interface initially surfaced missing fields (`bio`, `website`, `location`) that `SessionUser` doesn't include. Rather than audit all consumer sites, `currentUser` stays `any` for now. Worth tightening later.

### Test plan

- [x] `pnpm typecheck` — passes
- [x] `pnpm test` — 34/34 pass
- [ ] `pnpm dev` — verify SSR renders correctly (check view-source)
- [ ] Verify `/api/context` returns correct shape
- [ ] Verify auth redirect: unauthenticated visit to `/dashboard` returns 302
- [ ] Verify client-side navigation between routes (no full page reload, titles update)
- [ ] Verify no content doubling on any page
- [ ] `pnpm build && pnpm start` — verify production build
