/**
 * The terminal UI (local-tool-build.md phase 5): a sidebar of three cards (Remotes, On this
 * machine, Scripts and views) beside one main pane, with a key bar along the bottom. It calls
 * the library directly and watches home and the script folders, so what an agent or another terminal does
 * shows up as it happens. Runs start detached, so closing the UI never stops one.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Box, type Key as InkKey, Text, useApp, useInput, usePaste, useWindowSize } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { assetBytes, type AssetRow, extOf } from '../core/assets.js'
import {
  addCollection,
  KEEP_LABEL,
  newCollection,
  publish,
  removeCollection,
  type RemoteListing,
  setKeep,
  wouldLetGo,
} from '../core/collections.js'
import { listPublic } from '../core/collections.js'
import {
  addSource,
  getSetting,
  personalPath,
  removeRule,
  removeSource,
  setRule,
  setSetting,
  SETTINGS,
  type Keep,
} from '../core/config.js'
import { type Coll, type Ctx, openColl } from '../core/context.js'
import { type ColumnDraft, draftColumns, schemaFrom, TYPES } from '../core/draft.js'
import { CliError, tildePath } from '../core/env.js'
import { bytes, diffVersions } from '../core/format.js'
import { copyText, handoffPrompt, type HandoffTarget, sendHandoff } from '../core/handoff.js'
import {
  type CollectionMeta,
  isLocal,
  keyOf,
  LOCAL,
  LOCAL_ORG,
  parseRef,
  shortKey,
} from '../core/home.js'
import {
  addFile,
  defaultOptions,
  eject,
  type ImportOptions,
  readTable,
  saveImport,
} from '../core/importers.js'
import { nameFromFile, nameProblem, typeFromName } from '../core/names.js'
import { Remote } from '../core/remote.js'
import {
  inputPath,
  readRun,
  type RunRecord,
  saveFromRun,
  signalRun,
  startDetached,
} from '../core/runs.js'
import { findScript } from '../core/scripts.js'
import { type FileProgress, pull, push, pushPlan, StaleError } from '../core/sync.js'
import { checkForUpdate } from '../core/update.js'
import { squash, undo, unpushedOf, cidOf } from '../core/versions.js'
import { openInBrowser, serveView, type ServedView } from '../core/views.js'
import { FULL_VERSION } from '../version.js'
import { mascotOn } from './bird.js'
import {
  type CollectionDetail,
  loadBehind,
  loadCollection,
  loadRecords,
  loadRemote,
  loadSnapshot,
  type Snapshot,
} from './data.js'
import { Frame, KeyBar, Lines, windowed, windowStart } from './frame.js'
import { helpView, type Section } from './help.js'
import { C, type Key, type Line, type Pane } from './lines.js'
import { type MouseEvent, parseMouse } from './mouse.js'
import { fieldsOf, formKey, isLocalForm, type NewForm, newPane, typedField } from './newform.js'
import {
  collectionPane,
  FILE_FIELDS,
  type FileView,
  filePane,
  itemId,
  messagePane,
  namesKey,
  pickPane,
  pickRows,
  type PickView,
  pushPane,
  type PushView,
  runPane,
  runsPane,
  scriptPane,
  type SettingRow,
  sidebar,
  type Tab,
  TABS,
  viewPane,
} from './screens.js'
import {
  ADDS,
  editable,
  groupOf,
  GROUPS,
  resettable,
  settingsAbout,
  settingsItems,
  settingsKeys,
  settingsList,
} from './settings.js'

type Overlay = null | 'push' | 'pick' | 'settings' | 'file' | 'runs' | 'new' | { run: string }

interface Prompt {
  label: string
  value: string
  submit: (v: string) => void | Promise<void>
  /** Drawn in red: answering it loses something that can't be fetched again. */
  loud?: boolean
}

/** The sidebar's three cards; the one that has the keys is the one its selection is in. */
type SidePane = 'servers' | 'collections' | 'scripts'
const paneOf = (id: string): SidePane =>
  id.startsWith('r:')
    ? 'servers'
    : id.startsWith('s:') || id.startsWith('v:')
      ? 'scripts'
      : 'collections'

/** The sidebar's width: room for "Collections on this machine (c)" once the terminal has it. */
const sideWidth = (columns: number) =>
  Math.min(40, Math.max(columns >= 110 ? 37 : 30, Math.floor(columns * 0.27)))

const QUIT = 'Press x again to quit'

/** Where things were drawn, for the mouse: what is under a click depends on the screen. */
type Geo =
  | { mode: 'none' | 'help' }
  | { mode: 'settings'; listW: number; count: number; start: number }
  | {
      mode: 'main'
      sideW: number
      cards: { card: SidePane; top: number; h: number; lines: Line[]; start: number }[]
      pane: { left: number; lines: Line[]; start: number }
    }

const settingRows = (ctx: Ctx): SettingRow[] => {
  const rows: SettingRow[] = []
  for (const d of SETTINGS) {
    const v = getSetting(ctx.env, d.key)
    const group = d.group === 'Remotes' ? 'Remotes' : d.group
    rows.push({
      group,
      key: d.key,
      label: d.key.split('.').slice(1).join('.') || d.key,
      value: v.value,
      from: v.from,
      about: d.about,
      ...(d.help ? { help: d.help } : {}),
      ...(d.choices ? { choices: d.choices } : {}),
      kind: 'setting',
    })
  }
  if (ctx.env.homeDir)
    rows.splice(1, 0, {
      group: 'Home',
      key: '',
      label: 'UNDERLAY_HOME',
      value: tildePath(ctx.env, ctx.env.homeDir),
      from: 'env',
      about: 'set in the environment: wins over home',
      kind: 'info',
    })
  for (const x of ctx.sources)
    rows.push({
      group: 'Script folders',
      key: x.name,
      label: x.name,
      value: tildePath(ctx.env, x.root),
      from: x.how === 'listed' ? 'set' : x.how,
      about:
        x.how === 'home'
          ? 'home’s own scripts/'
          : x.how === 'here'
            ? 'the folder you are in (it has an underlay.toml)'
            : x.exists
              ? `listed in config.toml${x.need.length ? `; needs ${x.need.join(', ')}` : ''}`
              : 'not on this machine',
      kind: x.how === 'listed' ? 'source' : 'info',
    })
  for (const r of ctx.settings.rules)
    rows.push({
      group: 'Rules',
      key: r.match,
      label: r.match,
      value: [r.path ? `path ${tildePath(ctx.env, r.path)}` : '', r.keep ? `keep ${r.keep}` : '']
        .filter(Boolean)
        .join(', '),
      from: 'set',
      about: 'most specific match wins',
      kind: 'rule',
    })
  for (const r of ctx.settings.remotes) {
    const v = getSetting(ctx.env, `remotes.${r.name}.url`)
    const signed = ctx.env.keys.get(r.name) !== null
    rows.push({
      group: 'Remotes',
      key: `remotes.${r.name}.url`,
      label: r.name,
      value: v.value,
      from: v.from,
      about: signed ? `key in the ${ctx.env.keys.kind}` : `signed out: underlay login ${r.name}`,
      kind: 'remote',
    })
  }
  const order: readonly string[] = GROUPS
  return rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
}

export function App({
  ctx,
  initial,
  setTitle,
  mouse,
}: {
  ctx: Ctx
  initial?: { sel?: string }
  /** Titles the terminal tab "Underlay" again; tests leave it out. */
  setTitle?: () => void
  /** Turns mouse reporting on or off, around an editor or pager; tests leave it out. */
  mouse?: (on: boolean) => void
}) {
  const { exit, suspendTerminal: suspendInk } = useApp()
  // An editor or pager given the terminal may retitle the tab: title it again after.
  const suspendTerminal = useCallback(
    async (fn: () => Promise<void>) => {
      mouse?.(false)
      try {
        await suspendInk(fn)
      } finally {
        setTitle?.()
        mouse?.(true)
      }
    },
    [suspendInk, setTitle, mouse],
  )
  const size = useWindowSize()
  const columns = size.columns || 120
  const rows = size.rows || 40
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [remotes, setRemotes] = useState<Record<string, RemoteListing | { error: string }>>({})
  const [behind, setBehind] = useState<Record<string, number>>({})
  const [sel, setSel] = useState(initial?.sel ?? '')
  // Each card's last selection, so c, s and r go back to it.
  const lastSel = useRef<Record<SidePane, string>>({ servers: '', collections: '', scripts: '' })
  useEffect(() => {
    lastSel.current[paneOf(sel)] = sel
  }, [sel])
  const [focus, setFocus] = useState<'side' | 'main'>('side')
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [tab, setTab] = useState<Tab>('Overview')
  // A newer CLI, shown where the status line is when it is empty.
  const [updateOut, setUpdateOut] = useState(false)
  useEffect(() => {
    void checkForUpdate(ctx.env).then((a) => setUpdateOut(a !== null))
  }, [ctx])
  // Views that serve, started from here: stopped when the UI closes.
  const served = useRef(new Map<string, ServedView>())
  const [, setServedTick] = useState(0)
  useEffect(() => {
    const views = served.current
    const stopAll = () => views.forEach((v) => v.stop())
    process.once('exit', stopAll)
    return () => {
      stopAll()
      process.off('exit', stopAll)
    }
  }, [])
  const [detail, setDetail] = useState<{ key: string; d: CollectionDetail } | null>(null)
  const [records, setRecords] = useState<{ type: string; id: string; data: string }[] | undefined>()
  const [diff, setDiff] = useState<
    (Awaited<ReturnType<typeof diffVersions>> & { from: number; to: number }) | undefined
  >()
  const [scroll, setScroll] = useState(0)
  // The version selected in the Versions tab, newest first.
  const [vCursor, setVCursor] = useState(0)
  // The record and file selected in Records and Files, whether the record is open, and how far
  // a pane of text (Overview, Schemas, a record) is scrolled; how far it can go is drawn below.
  const [rCursor, setRCursor] = useState(0)
  const [fCursor, setFCursor] = useState(0)
  const [recordOpen, setRecordOpen] = useState(false)
  const [pScroll, setPScroll] = useState(0)
  const paneMax = useRef(0)
  useEffect(() => {
    setPScroll(0)
    setRecordOpen(false)
  }, [tab])
  // The sidebar row under the pointer, and where things were last drawn, for the mouse.
  const [hover, setHover] = useState<string | null>(null)
  const geo = useRef<Geo>({ mode: 'none' })
  // The new-collection form, what made it open, and what to do once the collection is made.
  const [newForm, setNewForm] = useState<NewForm | null>(null)
  const newThen = useRef<{
    back: Overlay
    made?: (meta: CollectionMeta, form: NewForm) => Promise<string | void>
  }>({
    back: null,
  })
  const [runLog, setRunLog] = useState<{ id: string; lines: string[] }>({ id: '', lines: [] })
  const [push_, setPush] = useState<PushView>({
    plans: [],
    included: new Set(),
    behind: {},
    cursor: 0,
    typed: '',
    progress: [],
    busy: false,
  })
  const [pick, setPick] = useState<PickView>({
    remote: '',
    tab: 'orgs',
    listing: null,
    public: null,
    open: new Set(),
    selected: new Map(),
    cursor: 0,
    search: '',
    searching: false,
    status: '',
  })
  const [settings, setSettings] = useState<{
    rows: SettingRow[]
    cursor: number
    editing: string | null
  }>({ rows: [], cursor: 0, editing: null })
  const [file, setFile] = useState<FileView | null>(null)
  // The woodpecker pecks while a push runs.
  useEffect(() => {
    if (!push_.busy) return
    const t = setInterval(() => setPush((v) => ({ ...v, frame: (v.frame ?? 0) + 1 })), 130)
    return () => clearInterval(t)
  }, [push_.busy])
  // The help screen (?): over whatever was open, which it goes back to.
  const [help, setHelp] = useState<{ from: Section; scroll: number | null } | null>(null)
  // Where the help screen was drawn scrolled to, and how far it goes, for j and k.
  const helpAt = useRef({ top: 0, max: 0 })
  const [runsCursor, setRunsCursor] = useState(0)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [status, setStatus] = useState('')
  const reloadSoon = useRef<NodeJS.Timeout | null>(null)
  const tick = useRef(0)

  // Every action is followed by a fresh read: the screen shows its result at once, not at
  // the next periodic refresh.
  const reloadRef = useRef<(() => Promise<void>) | null>(null)
  const attempt = useCallback(async (what: string, work: () => Promise<string | void>) => {
    setStatus(`${what}…`)
    try {
      const done = await work()
      setStatus(done ?? '')
      await reloadRef.current?.()
    } catch (err) {
      setStatus(
        err instanceof CliError
          ? err.message.split('\n').slice(0, 3).join(' · ')
          : `${what}: ${(err as Error).message}`,
      )
    }
  }, [])

  // --- Loading ---

  const reload = useCallback(async () => {
    try {
      const s = await loadSnapshot(ctx)
      setSnap(s)
    } catch (err) {
      setStatus(`Reading home: ${(err as Error).message}`)
    }
  }, [ctx])

  reloadRef.current = reload

  const refreshRemotes = useCallback(async () => {
    const s = await loadSnapshot(ctx)
    const out: Record<string, RemoteListing | { error: string }> = {}
    await Promise.all(
      s.remotes
        .filter((r) => r.signedIn)
        .map(async (r) => (out[r.name] = await loadRemote(ctx, r.name))),
    )
    setRemotes(out)
    setBehind(await loadBehind(ctx, s.collections))
  }, [ctx])

  useEffect(() => {
    void reload()
    void refreshRemotes()
    // Changes made outside the UI (an agent, another terminal) show up as they happen.
    const watchers: { close(): void }[] = []
    const poke = () => {
      if (reloadSoon.current) clearTimeout(reloadSoon.current)
      reloadSoon.current = setTimeout(() => void reload(), 250)
    }
    for (const dir of [
      ctx.home.root,
      ctx.settings.storePath,
      ...ctx.sources.filter((x) => x.how !== 'home' && x.exists).map((x) => x.root),
    ]) {
      try {
        watchers.push(
          watch(dir, { recursive: true }, (_e, name) => {
            if (
              name &&
              (name.startsWith('.git') ||
                name.includes('/tmp/') ||
                name.startsWith('tmp/') ||
                name.includes('node_modules') ||
                name.startsWith('records/'))
            )
              return
            poke()
          }),
        )
      } catch {
        // A folder that isn't there yet.
      }
    }
    const timer = setInterval(() => {
      tick.current++
      poke()
    }, 2000)
    return () => {
      watchers.forEach((w) => w.close())
      clearInterval(timer)
    }
  }, [ctx, reload, refreshRemotes])

  const side = useMemo(
    () => (snap ? sidebar(snap, remotes, behind, sel, sideWidth(columns)) : null),
    [snap, remotes, behind, sel, columns],
  )
  useEffect(() => {
    // A selection that is gone: the first in its card, or in Collections, where you start.
    if (!side || side.items.some((i) => itemId(i) === sel)) return
    const first = side.items.find((i) => paneOf(itemId(i)) === paneOf(sel))
    const next = first ? itemId(first) : ''
    if (next !== sel) setSel(next)
  }, [side, sel])

  const item = side?.items.find((i) => itemId(i) === sel) ?? null
  const collRow =
    item?.kind === 'coll' ? (snap?.collections.find((c) => c.key === item.key) ?? null) : null
  const script =
    item?.kind === 'script' || item?.kind === 'view'
      ? (snap?.scripts.find((s) => s.path === item.path) ?? null)
      : null
  const shownRun: RunRecord | null = (() => {
    if (overlay && typeof overlay === 'object')
      return snap?.runs.find((r) => r.id === overlay.run) ?? null
    if (!overlay && script?.last) return script.last
    return null
  })()

  // The selected collection's detail, again when its log changes.
  const collVersion = collRow
    ? `${collRow.key}@${collRow.status.head?.id ?? ''}@${collRow.meta.keep}`
    : ''
  useEffect(() => {
    if (!collRow) return
    let gone = false
    setRecords(undefined)
    setDiff(undefined)
    setVCursor(0)
    setRCursor(0)
    setFCursor(0)
    setRecordOpen(false)
    setPScroll(0)
    void loadCollection(ctx, collRow.meta).then(
      (d) => !gone && setDetail({ key: collRow.key, d }),
      (err) => !gone && setStatus((err as Error).message),
    )
    return () => {
      gone = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [collVersion])
  useEffect(() => {
    if (!collRow) return
    if (tab === 'Records' && !records)
      void loadRecords(ctx, collRow.meta, null, 200).then(setRecords, (e) =>
        setStatus((e as Error).message),
      )
    // The selected version's changes, against the one before it.
    // A detail read before an undo can name a version that is gone: wait for the new one.
    const v =
      tab === 'Versions' && detail?.key === collRow.key ? detail.d.versions[vCursor] : undefined
    const head = collRow.status.head?.number ?? 0
    if (v && v.number <= head && diff?.to !== v.number) {
      const c = openColl(ctx, collRow.meta)
      const to = v.number
      void diffVersions(c, to - 1, to).then(
        (d) => setDiff({ ...d, from: to - 1, to }),
        () => {},
      )
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, collVersion, records, diff, vCursor, detail])

  // A run's log, followed while it is shown.
  const runId = shownRun?.id ?? ''
  const runLive = shownRun?.status === 'running' || shownRun?.status === 'paused'
  // "Run … started" stops being true when the run ends: the run's own screen says how it went.
  useEffect(() => {
    if (shownRun && !runLive)
      setStatus((st) => (st.startsWith(`Run ${shownRun.id} started`) ? '' : st))
  }, [shownRun, runLive])
  useEffect(() => {
    if (!shownRun) return
    const read = () => {
      try {
        const text = existsSync(shownRun.log) ? readFileSync(shownRun.log, 'utf8') : ''
        const lines = text.split('\n')
        if (lines.at(-1) === '') lines.pop()
        setRunLog({ id: shownRun.id, lines: lines.slice(-5000) })
      } catch {
        // Not written yet.
      }
    }
    read()
    if (!runLive) return
    const t = setInterval(read, 500)
    return () => clearInterval(t)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, runLive])

  // --- Actions ---

  /** The push screen: for one collection (p on it), or for every one with versions to push (P). */
  // Which collection the push screen is for, so reopening it after a squash keeps it.
  const pushScope = useRef<string | undefined>(undefined)
  const openPush = useCallback(
    async (only?: string) => {
      pushScope.current = only
      const s = await loadSnapshot(ctx)
      const plans = (
        await Promise.all(
          s.collections
            .filter((c) => !only || c.key === only)
            .map((c) => pushPlan(openColl(ctx, c.meta))),
        )
      ).filter((p) => p !== null)
      if (only && !plans.length)
        return setStatus(`${only.split('/').pop()} has no versions that aren't pushed`)
      const b = await loadBehind(ctx, s.collections)
      setBehind(b)
      setPush({
        plans,
        included: new Set(plans.filter((p) => !b[p.coll.key]).map((p) => p.coll.key)),
        behind: b,
        cursor: 0,
        typed: '',
        progress: [],
        busy: false,
      })
      setOverlay('push')
      setFocus('main')
    },
    [ctx],
  )

  const runPush = useCallback(async () => {
    const chosen = push_.plans.filter(
      (p) => push_.included.has(p.coll.key) && !push_.behind[p.coll.key],
    )
    // Nothing to send is not a push that went well.
    if (chosen.length === 0) {
      const behind = push_.plans.some((p) => push_.behind[p.coll.key])
      setStatus(
        behind
          ? 'Behind its authority: l pulls first'
          : 'Nothing included: space includes a collection',
      )
      return
    }
    setPush((v) => ({
      ...v,
      busy: true,
      typed: '',
      peck: null,
      frame: 0,
      bird: mascotOn(ctx.env, { isTTY: true }),
    }))
    const progress: string[] = []
    const note = (t: string) => {
      progress.push(t)
      setPush((v) => ({ ...v, progress: [...progress] }))
    }
    const onFile = (f: FileProgress) => setPush((v) => ({ ...v, peck: f }))
    for (const p of chosen) {
      try {
        await push(ctx, p.coll, note, onFile)
      } catch (err) {
        note(
          err instanceof StaleError
            ? err.message.split('\n').join(' ')
            : `${p.coll.key}: ${(err as Error).message}`,
        )
      }
    }
    setPush((v) => ({ ...v, busy: false, plans: [], peck: null }))
    note('Done. esc goes back.')
    void reload()
  }, [ctx, push_, reload])

  const openPick = useCallback(
    async (remote: string) => {
      setPick({
        remote,
        tab: 'orgs',
        listing: remotes[remote] ?? null,
        public: null,
        open: new Set(),
        selected: new Map(),
        cursor: 0,
        search: '',
        searching: false,
        status: '',
      })
      setOverlay('pick')
      setFocus('main')
      const l = await loadRemote(ctx, remote)
      setPick((v) => ({
        ...v,
        listing: l,
        open: new Set(
          'orgs' in l
            ? l.orgs
                .filter((o) => o.collections.some((c) => c.here))
                .map((o) => o.slug)
                .slice(0, 3)
            : [],
        ),
      }))
    },
    [ctx, remotes],
  )

  const addPicked = useCallback(async () => {
    const chosen = [...pick.selected.entries()]
    if (!chosen.length) return
    // Each on its own: one that fails doesn't stop the rest, and stays selected to retry.
    const failed = new Map<string, Keep>()
    const problems: string[] = []
    let added = 0
    for (const [i, [name, k]] of chosen.entries()) {
      setPick((v) => ({ ...v, status: `Adding ${name} (${i + 1} of ${chosen.length})…` }))
      try {
        await addCollection(ctx, `${pick.remote}/${name}`, { keep: k })
        added++
      } catch (err) {
        failed.set(name, k)
        problems.push((err as Error).message)
      }
    }
    const l = await loadRemote(ctx, pick.remote)
    const done = added ? `Added ${added} of ${chosen.length}` : `Added none of ${chosen.length}`
    setPick((v) => ({
      ...v,
      selected: failed,
      listing: l,
      status: problems.length ? `${done}. ${problems.join(' · ')}` : `Added ${added}`,
    }))
    void reload()
  }, [ctx, pick, reload])

  // --- A schema drafted for an import whose type has none ---

  /** The draft for these options, or null when the type has a schema already. */
  const draftFor = useCallback(
    async (o: ImportOptions | null, path: string): Promise<ColumnDraft[] | null> => {
      if (!o) return null
      const ref = parseRef(o.collection, ctx.settings.defaultRemote)
      if (ctx.home.schemas(ref)[o.type] !== undefined) return null
      const t = await readTable(inputPath(ctx, path), o.sheet ? { sheet: o.sheet } : {})
      return draftColumns(t, o.id)
    },
    [ctx],
  )
  const schemaRel = (o: ImportOptions) => `schemas/${o.type}.json`
  /** With a draft, the cursor starts on its first column after the id: it is what needs you. */
  const draftStart = (draft: ColumnDraft[] | null) =>
    draft ? FILE_FIELDS.length + Math.min(1, draft.length - 1) : 0
  /** Write the drafted schema into the collection's schemas/; its path. */
  const saveDraft = (o: ImportOptions, draft: ColumnDraft[]) => {
    const ref = parseRef(o.collection, ctx.settings.defaultRemote)
    ctx.home.writeSchemas(ref, { [o.type]: schemaFrom(draft, o.id) })
    return join(ctx.home.collectionDir(ref), schemaRel(o))
  }
  /** The import's columns as the draft keeps them. */
  const withDraftColumns = (o: ImportOptions, draft: ColumnDraft[]): ImportOptions => ({
    ...o,
    columns: Object.fromEntries(
      draft.filter((c) => c.column !== o.id).map((c) => [c.column, c.keep ? c.field : '']),
    ),
  })

  const openFile = useCallback(
    async (path: string) => {
      await attempt('Reading the file', async () => {
        const shape = await addFile(
          ctx,
          path
            .trim()
            .replace(/^'(.*)'$/, '$1')
            .replace(/\\ /g, ' '),
        )
        const m = shape.matches[0]
        const target = m?.collection ?? snap?.collections[0]?.key
        let options = null
        if (target) {
          const meta = ctx.home.collection(parseRef(target, ctx.settings.defaultRemote))
          const type = m?.type ?? Object.keys(ctx.home.schemas(meta))[0] ?? 'Record'
          const t = await readTable(
            inputPath(ctx, shape.path),
            m && shape.tables.length > 1
              ? { sheet: m.table }
              : shape.tables.length > 1
                ? { sheet: shape.tables[0]!.name }
                : {},
          )
          try {
            options = defaultOptions(ctx, shape.path, t, {
              collection: target,
              type,
              ...(m ? { id: m.column } : {}),
              ...(shape.tables.length > 1 ? { sheet: t.name } : {}),
            })
          } catch {
            options = null
          }
        }
        const draft = await draftFor(options, shape.path)
        setFile({ shape, options, field: draftStart(draft), status: '', draft })
        setOverlay('file')
        setFocus('main')
        return ''
      })
    },
    [ctx, snap, attempt, draftFor],
  )

  const handoff = useCallback(
    (send: boolean, target: HandoffTarget) => {
      const text = handoffPrompt(ctx, target)
      if (!send)
        return setStatus(
          copyText(text) ? 'Prompt copied' : 'No clipboard here: the prompt is in the log',
        )
      void attempt('Sending the prompt', async () => {
        const out = sendHandoff(ctx, text)
        return `Sent${out ? `: ${out.split('\n')[0]}` : ''}`
      })
    },
    [ctx, attempt],
  )

  const startRun = useCallback(
    (path: string, args: string[] = []) => {
      const id = startDetached(ctx, path, args)
      setStatus(`Run ${id} started`)
      setOverlay({ run: id })
      setFocus('main')
      setScroll(0)
      setTimeout(() => void reload(), 300)
    },
    [ctx, reload],
  )

  const editInEditor = useCallback(
    async (path: string) => {
      await suspendTerminal(async () => {
        spawnSync(process.env.EDITOR ?? 'vi', [path], { stdio: 'inherit' })
      })
      void reload()
      setSettings((s) => ({ ...s, rows: settingRows(ctx) }))
    },
    [ctx, reload, suspendTerminal],
  )

  // --- Input ---

  usePaste(
    (text) => {
      if (prompt) return setPrompt((p) => p && { ...p, value: p.value + text.replace(/\n/g, ' ') })
      // A file dropped on the terminal arrives as its path.
      const path = text
        .trim()
        .replace(/^'(.*)'$/, '$1')
        .replace(/\\ /g, ' ')
      if (path && existsSync(path)) void openFile(path)
      else setStatus('Pasted text is not a file path')
    },
    { isActive: true },
  )

  const card = paneOf(sel)
  /** Give a sidebar card the keys, at its last selection; esc goes to Collections this way. */
  const goPane = (p: SidePane) => {
    const there = (side?.items ?? []).filter((i) => paneOf(itemId(i)) === p)
    // Servers start on one you're signed in to: a signed-out one's list is a dead end.
    const signedIn = there.find((i) => i.kind === 'remote' && ctx.env.keys.get(i.name) !== null)
    const to =
      there.find((i) => itemId(i) === lastSel.current[p]) ??
      (p === 'servers' ? signedIn : undefined) ??
      there[0]
    if (!to && p === 'scripts') return setStatus('No scripts yet: put one in scripts/')
    setSel(to ? itemId(to) : '')
    setOverlay(null)
    setFocus('side')
    setScroll(0)
  }

  /** Your orgs on a server, or null when signed out there (or not read yet). */
  const orgsOn = (server: string): string[] | null => {
    const l = remotes[server]
    return l && 'orgs' in l && l.signedIn ? l.orgs.map((o) => o.slug) : null
  }
  /** What is wrong with the form, checked as you type: the first push isn't where you find out. */
  const newProblem = (f: NewForm): string | null => {
    if (isLocalForm(f)) {
      const bad = nameProblem(f.name, null)
      if (bad) return bad
      if (ctx.home.readCollection({ authority: LOCAL, org: LOCAL_ORG, name: f.name }))
        return `${f.name} is already here`
      if (f.type !== null && !/^[A-Za-z][A-Za-z0-9_]*$/.test(f.type))
        return 'A type is letters, numbers, and underscores, starting with a letter'
      return null
    }
    if (!f.signedIn) return `Sign in to ${f.server}: paste a key, then enter`
    if (!f.org) return 'Choose an org'
    const bad = nameProblem(f.name, f.server)
    if (bad) return bad
    if (ctx.home.readCollection({ authority: f.server, org: f.org, name: f.name }))
      return `${f.org}/${f.name} is already here`
    const l = remotes[f.server]
    if (
      l &&
      'orgs' in l &&
      l.orgs.some((o) => o.slug === f.org && o.collections.some((c) => c.slug === f.name))
    )
      return `${f.server} already has ${f.org}/${f.name}: add it from Servers (s) instead`
    if (f.type !== null && !/^[A-Za-z][A-Za-z0-9_]*$/.test(f.type))
      return 'A type is letters, numbers, and underscores, starting with a letter'
    return null
  }
  /** Open the new-collection form, filled in from what is known, and what follows making it. */
  const openNew = (
    init: Partial<NewForm> = {},
    then: {
      back: Overlay
      made?: (meta: CollectionMeta, form: NewForm) => Promise<string | void>
    } = {
      back: null,
    },
  ) => {
    // The default server first: the one → goes to from this machine.
    const def = ctx.settings.defaultRemote
    const remoteNames = [def, ...(snap?.remotes.map((r) => r.name) ?? []).filter((n) => n !== def)]
    const publishing = init.publishing ?? null
    // This machine comes first when making one; publishing is to a server.
    const servers = publishing ? remoteNames : ['', ...remoteNames]
    // From a server's row, that server; otherwise this machine (publishing: the default server).
    const server =
      init.server ??
      (item?.kind === 'remote' ? item.name : publishing ? ctx.settings.defaultRemote : '')
    newThen.current = then
    setNewForm({
      servers,
      name: '',
      title: '',
      type: null,
      access: 'private',
      field: 'name',
      from: null,
      then: null,
      publishing: null,
      ...serverFields(server, init.org),
      ...init,
    })
    setOverlay('new')
    setFocus('main')
    void refreshRemotes()
  }
  /** The form's fields that follow from its server: signed in, where a key comes from, the orgs. */
  const serverFields = (server: string, org?: string) => {
    const orgs = server ? orgsOn(server) : null
    return {
      server,
      signedIn: server !== '' && ctx.env.keys.get(server) !== null,
      keyUrl: `${snap?.remotes.find((r) => r.name === server)?.url ?? `https://${server}`}/settings/keys`,
      key: '',
      orgs,
      org: org ?? orgs?.[0] ?? '',
    }
  }
  /** Publish a local collection: the form, for a server, then the push screen. */
  const openPublish = (meta: CollectionMeta) => {
    const versions = detail?.key === keyOf(meta) ? detail.d.versions.length : undefined
    openNew(
      {
        publishing: meta,
        name: meta.name,
        title: meta.title ?? '',
        ...(versions !== undefined ? { versions } : {}),
      },
      { back: null },
    )
  }
  // The orgs fill in once the server's list is read (or after signing in there).
  useEffect(() => {
    if (!newForm || newForm.orgs || !newForm.server) return
    const l = remotes[newForm.server]
    if (!l || !('orgs' in l) || !l.signedIn) return
    const orgs = l.orgs.map((o) => o.slug)
    setNewForm({ ...newForm, orgs, org: newForm.org || orgs[0] || '' })
  }, [remotes, newForm])

  /** Move within the collection pane: the selected version, record or file, or the scroll. */
  const moveInPane = (delta: number) => {
    const to = (n: number, max: number) => Math.max(0, Math.min(Math.max(0, max), n))
    if (!collRow) return
    const d = detail?.key === collRow.key ? detail.d : null
    if (tab === 'Versions') return setVCursor((i) => to(i + delta, (d?.versions.length ?? 1) - 1))
    if (tab === 'Records' && !recordOpen)
      return setRCursor((i) => to(i + delta, (records?.length ?? 1) - 1))
    if (tab === 'Files') return setFCursor((i) => to(i + delta, (d?.assets?.length ?? 1) - 1))
    setPScroll((x) => to(x + delta, paneMax.current))
  }

  /** A file, opened in the app the system gives its type; fetched for this if it isn't here. */
  const openAsset = (c: Coll, f: AssetRow) =>
    attempt(`Opening ${f.hash.slice(0, 12)}`, async () => {
      const { bytes: b, fetched } = await assetBytes(c, f.hash)
      const dir = join(tmpdir(), 'underlay-files')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${f.hash.slice(0, 12)}${extOf(f.mediaType)}`)
      writeFileSync(path, b)
      openInBrowser(path)
      return `Opened ${f.hash.slice(0, 12)} (${bytes(f.size)})${fetched ? `: fetched for this, not kept here (k → everything keeps files)` : ''}`
    })

  /** A copy of a file in Downloads, named for the record that points to it where there is one. */
  const saveAsset = (c: Coll, f: AssetRow & { pointedBy?: string }) =>
    attempt(`Saving ${f.hash.slice(0, 12)}`, async () => {
      const { bytes: b } = await assetBytes(c, f.hash)
      const downloads = join(ctx.env.home, 'Downloads')
      const dir = existsSync(downloads) ? downloads : ctx.env.home
      const stem = f.pointedBy
        ? `${f.pointedBy.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${f.hash.slice(0, 12)}`
        : f.hash.slice(0, 12)
      const path = join(dir, `${stem}${extOf(f.mediaType)}`)
      writeFileSync(path, b)
      return `Saved ${tildePath(ctx.env, path)}`
    })

  /** Which section of the help screen is where you are. */
  const hereSection = (): Section =>
    overlay === 'settings'
      ? 'settings'
      : overlay === 'push'
        ? 'push'
        : overlay === 'pick'
          ? 'adding from a remote'
          : overlay === 'file'
            ? 'a file'
            : overlay === 'runs' || (typeof overlay === 'object' && overlay !== null)
              ? 'a run'
              : collRow
                ? 'a collection'
                : script?.kind === 'view'
                  ? 'a view'
                  : script
                    ? 'a script'
                    : 'anywhere'

  const onKey = (input: string, key: InkKey) => {
    // The mouse comes in as input too: clicks, the wheel, and movement.
    const mouseEvents = parseMouse(input)
    if (mouseEvents) return onMouse(mouseEvents)
    if (prompt) {
      if (key.escape) return setPrompt(null)
      if (key.return) {
        // The latest value: keys typed quickly arrive before this render's closure sees them.
        setPrompt((p) => {
          if (p)
            queueMicrotask(
              () =>
                void Promise.resolve(p.submit(p.value)).catch((e) =>
                  setStatus((e as Error).message),
                ),
            )
          return null
        })
        return
      }
      if (key.backspace || key.delete)
        return setPrompt((p) => p && { ...p, value: p.value.slice(0, -1) })
      if (input && !key.ctrl && !key.meta) setPrompt((p) => p && { ...p, value: p.value + input })
      return
    }
    if (key.ctrl && input === 'c') return exit()
    // Any key but x takes back "Press x again to quit".
    if (status === QUIT && input !== 'x') setStatus('')

    // The help screen: j and k scroll it; any other key closes it.
    if (help) {
      const { top, max } = helpAt.current
      if (key.downArrow || input === 'j')
        return setHelp({ ...help, scroll: Math.min(max, top + 1) })
      if (key.upArrow || input === 'k') return setHelp({ ...help, scroll: Math.max(0, top - 1) })
      return setHelp(null)
    }
    const typing =
      overlay === 'new' ||
      (overlay === 'settings' && settings.editing !== null) ||
      (overlay === 'pick' && pick.searching)
    if (input === '?' && !typing) return setHelp({ from: hereSection(), scroll: null })
    // c, s and r give a card the keys, from anywhere but the screens that take letters.
    if (!typing && (overlay === null || overlay === 'runs' || typeof overlay === 'object')) {
      if (input === 'c') return goPane('collections')
      if (input === 's') return goPane('servers')
      if (input === 'r') return goPane('scripts')
    }

    // The new-collection form.
    if (overlay === 'new' && newForm) {
      const f = newForm
      const fields = fieldsOf(f)
      const i = fields.indexOf(f.field)
      if (key.escape) {
        setNewForm(null)
        const back = newThen.current.back
        return back ? setOverlay(back) : goPane('collections')
      }
      if (key.tab || key.downArrow)
        return setNewForm({ ...f, field: fields[(i + 1) % fields.length]! })
      if (key.upArrow)
        return setNewForm({ ...f, field: fields[(i + fields.length - 1) % fields.length]! })
      if (key.return && f.field === 'key' && f.key.trim()) {
        // Sign in from the form, as `underlay login` does.
        const keyText = f.key.trim()
        return void attempt(`Signing in to ${f.server}`, async () => {
          const url = Remote.open(ctx.env, ctx.settings, f.server).url
          const me = await new Remote(f.server, url, keyText, ctx.env.fetch).me()
          ctx.env.keys.set(f.server, keyText)
          if (!ctx.settings.remotes.some((r) => r.name === f.server))
            setSetting(ctx.env, `remotes.${f.server}.url`, url)
          const orgs = me.orgs.map((o) => o.slug)
          setNewForm({ ...f, signedIn: true, key: '', orgs, org: orgs[0] ?? '', field: 'org' })
          void refreshRemotes()
          return `Signed in to ${f.server} as ${me.name}`
        })
      }
      if (key.return) {
        const problem = newProblem(f)
        if (problem) return setStatus(problem)
        const to = formKey(f)
        const opts = {
          access: f.access,
          ...(f.title.trim() ? { title: f.title.trim() } : {}),
        }
        if (f.publishing) {
          const from = f.publishing
          return void attempt(`Publishing ${from.name}`, async () => {
            const meta = publish(ctx, from, to, opts)
            setNewForm(null)
            await reload()
            setSel(`c:${keyOf(meta)}`)
            setTab('Overview')
            // Its versions, to push now; esc there leaves it new on the server, pushed later.
            await openPush(keyOf(meta))
            return `${from.name} is now ${keyOf(meta)}; this push creates it on ${meta.authority}`
          })
        }
        return void attempt(`Making ${f.name}`, async () => {
          const meta = newCollection(ctx, to, opts)
          setNewForm(null)
          await reload()
          const made = newThen.current.made
          if (made) return (await made(meta, f)) ?? ''
          setSel(`c:${keyOf(meta)}`)
          setOverlay(null)
          setFocus('main')
          setTab('Overview')
          return isLocal(meta)
            ? `Made ${meta.name} on this machine; p publishes it to a server`
            : `Made ${f.org}/${f.name} here; your first push creates it on ${f.server}`
        })
      }
      if (f.field === 'server' && (key.leftArrow || key.rightArrow) && f.servers.length > 1) {
        const at = f.servers.indexOf(f.server)
        const server =
          f.servers[(at + (key.rightArrow ? 1 : f.servers.length - 1)) % f.servers.length]!
        return setNewForm({ ...f, ...serverFields(server) })
      }
      if (f.field === 'org' && f.orgs && (key.leftArrow || key.rightArrow) && f.orgs.length > 1) {
        const at = f.orgs.indexOf(f.org)
        return setNewForm({
          ...f,
          org: f.orgs[(at + (key.rightArrow ? 1 : f.orgs.length - 1)) % f.orgs.length]!,
        })
      }
      if (f.field === 'access' && input === ' ')
        return setNewForm({ ...f, access: f.access === 'private' ? 'public' : 'private' })
      if (typedField(f, f.field)) {
        const k = f.field as 'name' | 'title' | 'type' | 'org' | 'key'
        if (key.backspace || key.delete) return setNewForm({ ...f, [k]: f[k]!.slice(0, -1) })
        if (input && !key.ctrl && !key.meta) {
          // Names and orgs are slugs: lowercase, and a space becomes a hyphen.
          const add = k === 'name' || k === 'org' ? input.toLowerCase().replace(/ /g, '-') : input
          return setNewForm({ ...f, [k]: f[k]! + add })
        }
      }
      return
    }

    // The push screen takes typing.
    if (overlay === 'push') {
      if (key.escape) return goPane('collections')
      if (push_.busy) return
      const loud = push_.plans.some(
        (p) => push_.included.has(p.coll.key) && (p.access === 'public' || p.removed >= 1000),
      )
      if (key.upArrow) return setPush((v) => ({ ...v, cursor: Math.max(0, v.cursor - 1) }))
      if (key.downArrow)
        return setPush((v) => ({ ...v, cursor: Math.min(v.plans.length - 1, v.cursor + 1) }))
      if (input === ' ') {
        const p = push_.plans[push_.cursor]
        if (!p || push_.behind[p.coll.key]) return
        const inc = new Set(push_.included)
        if (inc.has(p.coll.key)) inc.delete(p.coll.key)
        else inc.add(p.coll.key)
        return setPush((v) => ({ ...v, included: inc }))
      }
      if (loud) {
        if (key.backspace || key.delete)
          return setPush((v) => ({ ...v, typed: v.typed.slice(0, -1) }))
        if (key.return)
          return push_.typed === 'push' ? void runPush() : setStatus('Type push to go ahead')
        if (/^[a-z]$/.test(input))
          return setPush((v) => ({ ...v, typed: (v.typed + input).slice(-4) }))
        return
      }
      if (input === 'y') return void runPush()
      // Pull what is behind, from here: their versions in, yours replayed on top, then the
      // plan again.
      if (input === 'l' && push_.plans.some((p) => push_.behind[p.coll.key]))
        return void attempt('Pulling', async () => {
          const said: string[] = []
          for (const p of push_.plans.filter((x) => push_.behind[x.coll.key])) {
            const r = await pull(ctx, p.coll)
            said.push(
              `${p.coll.meta.name}: ${r.fetched} new${r.replayed.length ? `, yours replayed as ${r.replayed.map((x) => x.to.commit.semver).join(', ')}` : ''}`,
            )
          }
          await openPush(pushScope.current)
          return said.join(' · ')
        })
      const p = push_.plans[push_.cursor]
      if (input === 'd' && p)
        return (setOverlay(null), setSel(`c:${p.coll.key}`), setTab('Versions'), setVCursor(0))
      if (input === 'S' && p)
        return void attempt('Squashing', async () => {
          const s = await squash(p.coll, undefined, null, ctx.env.now())
          await openPush(pushScope.current)
          return s ? `Squashed into ${s.commit.semver}` : 'They cancelled out'
        })
      if (input === 'e' && p) {
        const last = p.versions.at(-1)!
        return setPrompt({
          label: `Message for ${p.coll.meta.name} ${last.semver}`,
          value: last.message ?? '',
          submit: async (v) => {
            const { reword } = await import('../core/versions.js')
            await reword(p.coll, last.number, v, ctx.env.now())
            await openPush(pushScope.current)
          },
        })
      }
      return
    }

    if (overlay === 'pick') {
      const rowsP = pickRows(pick)
      if (pick.searching) {
        if (key.escape) return setPick((v) => ({ ...v, searching: false }))
        if (key.return) {
          setPick((v) => ({ ...v, searching: false, tab: 'public', public: null, cursor: 0 }))
          return void listPublic(ctx, pick.remote, pick.search || undefined).then(
            (p) => setPick((v) => ({ ...v, public: p })),
            (e) => setPick((v) => ({ ...v, status: (e as Error).message })),
          )
        }
        if (key.backspace || key.delete)
          return setPick((v) => ({ ...v, search: v.search.slice(0, -1) }))
        if (input) return setPick((v) => ({ ...v, search: v.search + input }))
        return
      }
      if (key.escape) return goPane('collections')
      if (key.upArrow) return setPick((v) => ({ ...v, cursor: Math.max(0, v.cursor - 1) }))
      if (key.downArrow)
        return setPick((v) => ({ ...v, cursor: Math.min(rowsP.length - 1, v.cursor + 1) }))
      if (key.tab) {
        const t = pick.tab === 'orgs' ? 'public' : 'orgs'
        setPick((v) => ({ ...v, tab: t, cursor: 0 }))
        if (t === 'public' && !pick.public)
          void listPublic(ctx, pick.remote).then(
            (p) => setPick((v) => ({ ...v, public: p })),
            (e) => setPick((v) => ({ ...v, status: (e as Error).message })),
          )
        return
      }
      if (input === '/') return setPick((v) => ({ ...v, searching: true }))
      const r = rowsP[pick.cursor]
      if (r?.kind === 'org' && (key.rightArrow || key.leftArrow || input === ' ')) {
        const open = new Set(pick.open)
        if (key.leftArrow || (open.has(r.org) && !key.rightArrow)) open.delete(r.org)
        else open.add(r.org)
        return setPick((v) => ({ ...v, open }))
      }
      if (r?.kind === 'coll' && r.coll && !r.coll.here) {
        const name = `${r.org}/${r.coll.slug}`
        if (input === ' ') {
          const m = new Map(pick.selected)
          if (m.has(name)) m.delete(name)
          else m.set(name, (r.coll.totalBytes ?? 0) > 500e6 ? 'none' : 'all')
          return setPick((v) => ({ ...v, selected: m }))
        }
        if (input === 'k' && pick.selected.has(name)) {
          const m = new Map(pick.selected)
          const order: Keep[] = ['all', 'records', 'none']
          m.set(name, order[(order.indexOf(m.get(name) ?? 'all') + 1) % order.length]!)
          return setPick((v) => ({ ...v, selected: m }))
        }
      }
      if (key.return) return void addPicked()
      return
    }

    if (overlay === 'settings') {
      const s = settings
      const items = settingsItems(s.rows)
      const it = items[s.cursor]
      const row = it?.kind === 'row' ? it.row : null
      const refresh = (cursor = s.cursor) => {
        const rows = settingRows(ctx)
        setSettings({
          rows,
          cursor: Math.min(cursor, settingsItems(rows).length - 1),
          editing: null,
        })
      }
      if (s.editing !== null) {
        if (key.escape) return setSettings({ ...s, editing: null })
        if (key.return && row) {
          try {
            if (row.kind === 'rule') {
              const keepM = /keep (all|some|none)/.exec(s.editing)?.[1]
              const pathM = /path ([^,]+)/.exec(s.editing)?.[1]?.trim()
              setRule(ctx.env, {
                match: row.key,
                ...(pathM ? { path: pathM } : {}),
                ...(keepM ? { keep: keepM as 'all' } : {}),
              })
            } else setSetting(ctx.env, row.key, s.editing)
            setStatus(`${row.label} saved`)
          } catch (err) {
            setStatus((err as Error).message)
          }
          void reload()
          return refresh()
        }
        if (key.backspace || key.delete)
          return setSettings((x) => ({ ...x, editing: (x.editing ?? '').slice(0, -1) }))
        if (input && !key.ctrl && !key.meta)
          return setSettings((x) => ({ ...x, editing: (x.editing ?? '') + input }))
        return
      }
      if (key.escape) return goPane('collections')
      if (key.upArrow || input === 'k')
        return setSettings({ ...s, cursor: Math.max(0, s.cursor - 1) })
      if (key.downArrow || input === 'j')
        return setSettings({ ...s, cursor: Math.min(items.length - 1, s.cursor + 1) })
      // J and K: to the next or previous section's own row.
      if (input === 'J' || input === 'K') {
        const starts = items.flatMap((x, i) => (x.kind === 'section' ? [i] : []))
        const next =
          input === 'J'
            ? starts.find((i) => i > s.cursor)
            : starts.filter((i) => i < s.cursor).at(-1)
        return setSettings({ ...s, cursor: next ?? s.cursor })
      }
      if (key.return && row && editable(row)) {
        if (row.choices) {
          // A setting with a few values steps to the next, as Hopper's do.
          const at = row.choices.indexOf(row.value)
          const next = row.choices[(at + 1) % row.choices.length]!
          try {
            setSetting(ctx.env, row.key, next)
            setStatus(`${row.label}: ${next}`)
          } catch (err) {
            setStatus((err as Error).message)
          }
          return refresh()
        }
        return setSettings({ ...s, editing: row.from === 'set' ? row.value : '' })
      }
      if (input === 'd' && row && resettable(row)) {
        if (row.kind === 'rule') removeRule(ctx.env, row.key)
        else if (row.kind === 'source') removeSource(ctx.env, row.key)
        else setSetting(ctx.env, row.key, undefined)
        setStatus(
          row.kind === 'rule' || row.kind === 'source'
            ? `${row.label} removed`
            : `${row.label} back to the default`,
        )
        void reload()
        return refresh()
      }
      const group = groupOf(it)
      if (input === 'a' && ADDS[group]) {
        const add = (label: string, apply: (v: string) => void) =>
          setPrompt({
            label,
            value: '',
            submit: (v) => {
              if (!v.trim()) return
              try {
                apply(v.trim())
              } catch (err) {
                return setStatus((err as Error).message)
              }
              void reload()
              refresh()
            },
          })
        if (group === 'Rules')
          return add(
            'New rule: authority/org/name (with * at the end), then path and keep, e.g. underlay.org/mitp/* keep all',
            (v) => {
              const [match, ...rest] = v.split(/\s+/)
              const words = rest.join(' ')
              const k = /keep (all|some|none)/.exec(words)?.[1] as 'all' | undefined
              const p = /path (\S+)/.exec(words)?.[1]
              setRule(ctx.env, {
                match: match!,
                ...(p ? { path: p } : {}),
                ...(k ? { keep: k } : {}),
              })
            },
          )
        if (group === 'Remotes')
          return add(
            'New remote: its name, then its URL, e.g. lab https://underlay.lab.org',
            (v) => {
              const [name, url] = v.split(/\s+/)
              if (!name || !url) throw new CliError('A name, then a URL')
              setSetting(ctx.env, `remotes.${name}.url`, url)
            },
          )
        if (group === 'Script folders')
          return add('A folder of scripts to add (its path)', (v) => {
            addSource(ctx.env, v)
          })
      }
      if (input === 'o') return void editInEditor(personalPath(ctx.env))
      return
    }

    if (overlay === 'file' && file) {
      if (key.escape) return goPane('collections')
      const rows = FILE_FIELDS.length + (file.draft?.length ?? 0)
      if (key.tab || key.downArrow) return setFile({ ...file, field: (file.field + 1) % rows })
      if (key.upArrow) return setFile({ ...file, field: (file.field + rows - 1) % rows })
      const o = file.options
      // n: nothing here matches, so make a collection from the file.
      if (input === 'n' && !file.shape.matches.length) {
        const t = file.shape.tables.find((x) => x.name === o?.sheet) ?? file.shape.tables[0]
        const base = file.shape.path.split('/').pop()!
        return openNew(
          {
            name: nameFromFile(base),
            type: typeFromName(file.shape.tables.length > 1 && t ? t.name : base),
            from: base,
            then: 'make it, then shape its schema',
          },
          {
            back: 'file',
            made: async (meta, f) => {
              const tt = await readTable(inputPath(ctx, file.shape.path), {
                ...(file.shape.tables.length > 1 && t ? { sheet: t.name } : {}),
              })
              const options = defaultOptions(ctx, file.shape.path, tt, {
                collection: keyOf(meta),
                type: f.type || 'Record',
                ...(file.shape.tables.length > 1 ? { sheet: tt.name } : {}),
              })
              const draft = await draftFor(options, file.shape.path)
              setFile({ ...file, options, field: draftStart(draft), draft })
              setOverlay('file')
              setFocus('main')
              return `Made ${shortKey(meta)} here; now shape its schema`
            },
          },
        )
      }
      // A drafted column: ←→ its type, space keeps it or leaves it out (the id stays).
      const di = file.field - FILE_FIELDS.length
      if (file.draft && di >= 0) {
        const c = file.draft[di]!
        const set = (patch: Partial<ColumnDraft>) =>
          setFile({
            ...file,
            draft: file.draft!.map((x, j) => (j === di ? { ...x, ...patch } : x)),
          })
        if (di > 0 && (key.leftArrow || key.rightArrow)) {
          const at = TYPES.indexOf(c.type)
          return set({
            type: TYPES[(at + (key.rightArrow ? 1 : TYPES.length - 1)) % TYPES.length]!,
          })
        }
        if (di > 0 && input === ' ') return set({ keep: !c.keep })
        if (key.leftArrow || key.rightArrow || input === ' ') return
      }
      // e: the draft as JSON in $EDITOR; what you save there is the schema.
      if (input === 'e' && file.draft && o) {
        const draft = file.draft
        const path = saveDraft(o, draft)
        return void editInEditor(path).then(() =>
          setFile((fv) =>
            fv
              ? {
                  ...fv,
                  draft: null,
                  options: withDraftColumns(o, draft),
                  status: `Saved ${schemaRel(o)} from your edit; enter imports`,
                }
              : fv,
          ),
        )
      }
      if (o && (key.leftArrow || key.rightArrow)) {
        const dir = key.rightArrow ? 1 : -1
        const f = FILE_FIELDS[file.field]!
        const cycle = <T,>(list: T[], now: T) =>
          list[(list.indexOf(now) + dir + list.length) % list.length]!
        const t =
          file.shape.tables.find((x) => x.name === (o.sheet ?? file.shape.tables[0]!.name)) ??
          file.shape.tables[0]!
        const next = { ...o, columns: { ...o.columns } }
        if (f === 'sheet')
          next.sheet = cycle(
            file.shape.tables.map((x) => x.name),
            o.sheet ?? t.name,
          )
        if (f === 'collection')
          next.collection = cycle(
            snap!.collections.map((c) => c.key),
            o.collection,
          )
        if (f === 'type') {
          const types = Object.keys(
            ctx.home.schemas(parseRef(o.collection, ctx.settings.defaultRemote)),
          )
          if (types.length) next.type = cycle(types, o.type)
        }
        if (f === 'id') next.id = cycle(t.columns, o.id)
        if (f === 'missing_id') next.missing_id = o.missing_id === 'hold' ? 'skip' : 'hold'
        if (f === 'mode') next.mode = o.mode === 'set' ? 'additions' : 'set'
        if (f === 'sheet' || f === 'collection' || f === 'id' || f === 'type') {
          // Columns follow the sheet and the schema.
          void readTable(inputPath(ctx, file.shape.path), {
            ...(next.sheet ? { sheet: next.sheet } : {}),
          }).then(
            (tt) => {
              const d = defaultOptions(ctx, file.shape.path, tt, {
                collection: next.collection,
                type: next.type,
                id: tt.columns.includes(next.id) ? next.id : tt.columns[0]!,
                ...(next.sheet ? { sheet: next.sheet } : {}),
              })
              const options = { ...d, missing_id: next.missing_id, mode: next.mode }
              void draftFor(options, file.shape.path).then((draft) =>
                setFile((fv) => (fv ? { ...fv, options, draft } : fv)),
              )
            },
            (e) => setStatus((e as Error).message),
          )
        }
        return setFile({ ...file, options: next })
      }
      if (key.return && o && file.draft) {
        saveDraft(o, file.draft)
        const withCols = withDraftColumns(o, file.draft)
        setFile({ ...file, options: withCols, draft: null })
        const name = file.shape.path
          .split('/')
          .pop()!
          .replace(/\.[^.]+$/, '')
          .replace(/[^A-Za-z0-9._-]/g, '-')
        const rel = saveImport(ctx, name, withCols)
        startRun(rel, [file.shape.path])
        return setStatus(`Saved ${schemaRel(o)} and imports/${name}; importing`)
      }
      if (key.return && o) {
        const name = file.shape.path
          .split('/')
          .pop()!
          .replace(/\.[^.]+$/, '')
          .replace(/[^A-Za-z0-9._-]/g, '-')
        const rel = saveImport(ctx, name, o)
        return startRun(rel, [file.shape.path])
      }
      if (input === 'x' && o) {
        const name = file.shape.path
          .split('/')
          .pop()!
          .replace(/\.[^.]+$/, '')
          .replace(/[^A-Za-z0-9._-]/g, '-')
        const rel = saveImport(ctx, name, o)
        try {
          setStatus(`Wrote ${eject(ctx, findScript(ctx, rel))}`)
        } catch (err) {
          setStatus((err as Error).message)
        }
        return void reload()
      }
      if (input === 'a' || input === 'A')
        return handoff(input === 'A', {
          kind: 'file',
          shape: file.shape,
          ...(file.draft && o
            ? {
                draft: {
                  collection: o.collection,
                  type: o.type,
                  schema: schemaFrom(file.draft, o.id),
                  path: schemaRel(o),
                },
              }
            : {}),
        })
      return
    }

    if (overlay === 'runs') {
      const runs = snap?.runs ?? []
      if (key.escape) return goPane('collections')
      if (key.upArrow) return setRunsCursor((c) => Math.max(0, c - 1))
      if (key.downArrow) return setRunsCursor((c) => Math.min(runs.length - 1, c + 1))
      if (key.return && runs[runsCursor])
        return (setOverlay({ run: runs[runsCursor]!.id }), setScroll(0))
      return
    }

    // A run shown (from a script, or opened).
    if (
      shownRun &&
      (focus === 'main' || (overlay && typeof overlay === 'object') || item?.kind === 'script')
    ) {
      const live = shownRun.status === 'running' || shownRun.status === 'paused'
      if (live) {
        if (input === 'X')
          return void attempt(
            'Cancelling',
            async () => (signalRun(ctx, shownRun.id, 'cancel'), 'Cancelled'),
          )
        if (input === ' ')
          return void attempt(
            shownRun.status === 'paused' ? 'Resuming' : 'Pausing',
            async () => (
              signalRun(ctx, shownRun.id, shownRun.status === 'paused' ? 'resume' : 'pause'),
              ''
            ),
          )
        if (key.upArrow) return setScroll((x) => Math.min(runLog.lines.length, x + 1))
        if (key.downArrow) return setScroll((x) => Math.max(0, x - 1))
      }
      if (input === 'R') {
        if (live) signalRun(ctx, shownRun.id, 'cancel')
        return startRun(shownRun.path ?? shownRun.script, shownRun.args)
      }
      // n: make a collection the run wrote but that isn't here, from its records.
      if (!live && input === 'n' && shownRun.missing?.length) {
        const m = shownRun.missing[0]!
        const ref = parseRef(m.collection, ctx.settings.defaultRemote)
        const runId = shownRun.id
        return openNew(
          {
            ...(isLocal(ref) ? { server: '' } : { server: ref.authority, org: ref.org }),
            name: ref.name,
            from: `${shownRun.script}'s run ${runId}`,
          },
          {
            back: overlay,
            made: async (meta) => {
              const s = await saveFromRun(ctx, runId, m.collection, meta)
              await reload()
              setSel(`c:${keyOf(meta)}`)
              setOverlay(null)
              setFocus('main')
              setTab('Overview')
              return `Made ${shortKey(meta)} with this run's ${s.added.toLocaleString('en-US')} ${s.types.join(', ')} records as ${s.semver}, not pushed`
            },
          },
        )
      }
      if (!live && input === 'u' && shownRun.saved.length)
        return void attempt('Undoing this run', async () => {
          const undone: string[] = []
          for (const s of shownRun.saved) {
            const meta = ctx.home.resolve(s.collection)
            const c = openColl(ctx, meta)
            const list = await unpushedOf(c)
            const note = c.store.state(cidOf(c)).versions[list.at(-1)?.id ?? '']
            if (note?.change !== s.change)
              throw new CliError(
                `${s.collection}: its newest version is no longer this run's; undo it from the collection`,
              )
            await undo(c)
            undone.push(`${meta.name} ${s.semver}`)
          }
          void reload()
          return `Undone: ${undone.join(', ')}`
        })
      if (!live && key.return)
        return void suspendTerminal(async () => {
          spawnSync(process.env.PAGER ?? 'less', ['+G', shownRun.log], { stdio: 'inherit' })
        })
      if (input === 'a' || input === 'A')
        return handoff(input === 'A', { kind: 'run', run: readRun(ctx, shownRun.id) })
      if (key.escape && overlay) return goPane('collections')
    }

    // --- Everywhere else ---
    // x twice quits, as in Hopper: the first says so.
    if (input === 'x') return status === QUIT ? exit() : setStatus(QUIT)
    if (input === ',')
      return (
        setSettings({ rows: settingRows(ctx), cursor: 0, editing: null }),
        setOverlay('settings'),
        setFocus('main')
      )
    if (input === 'p' && collRow && isLocal(collRow.meta)) return openPublish(collRow.meta)
    if (input === 'p') return void openPush(collRow?.key)
    if (input === 'P') return void openPush()
    // n: a new collection, from the Collections card (in a collection's Records tab, n pages).
    if (input === 'n' && !overlay && card === 'collections' && (focus === 'side' || !collRow))
      return openNew()
    // + starts a new collection; adding one from a server is enter on the server (s).
    if (input === '+') return openNew()
    if (input === 'h') return (setRunsCursor(0), setOverlay('runs'), setFocus('main'))
    if (input === 'f')
      return setPrompt({
        label: 'A file to add (or drop one on the terminal)',
        value: '',
        submit: (v) => openFile(v),
      })
    if (key.escape && recordOpen && focus === 'main') return setRecordOpen(false)
    if (key.escape) return goPane('collections')
    if (key.tab) return setFocus((f) => (f === 'side' ? 'main' : 'side'))

    // With the collection pane's keys, up and down (and page up and down) stay in the pane.
    if (
      focus === 'main' &&
      collRow &&
      !overlay &&
      (key.upArrow || key.downArrow || key.pageUp || key.pageDown)
    ) {
      const page = Math.max(1, rows - 10)
      moveInPane(key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -page : page)
      return
    }
    // Up and down move through the card that has the keys, wherever the keys are.
    if (key.upArrow || key.downArrow) {
      const items = (side?.items ?? []).filter((i) => paneOf(itemId(i)) === card)
      const at = items.findIndex((i) => itemId(i) === sel)
      const next = items[Math.min(items.length - 1, Math.max(0, at + (key.upArrow ? -1 : 1)))]
      if (next) {
        setSel(itemId(next))
        setOverlay(null)
        setScroll(0)
      }
      return
    }

    if (item?.kind === 'remote' && key.return) return void openPick(item.name)
    if (script?.kind === 'view') {
      if (input === 'v') {
        if (script.view === 'page') {
          openInBrowser(script.path)
          return setStatus(`Opened ${tildePath(ctx.env, script.path)}`)
        }
        const running = served.current.get(script.path)
        if (running) {
          openInBrowser(running.url)
          return setStatus(`Opened ${running.url}`)
        }
        return void attempt(`Starting ${script.name}`, async () => {
          const v = await serveView(ctx, script)
          served.current.set(script.path, v)
          v.child.once('exit', () => {
            served.current.delete(script.path)
            setServedTick((n) => n + 1)
          })
          setServedTick((n) => n + 1)
          openInBrowser(v.url)
          return `${script.name} at ${v.url}`
        })
      }
      if (input === 'X' && served.current.has(script.path)) {
        served.current.get(script.path)!.stop()
        served.current.delete(script.path)
        setServedTick((n) => n + 1)
        return setStatus(`Stopped ${script.name}`)
      }
      return
    }
    if (script) {
      if (input === 'R')
        return script.takes
          ? setPrompt({
              label: `${script.name} takes ${script.takes}: which file (empty for none)`,
              value: '',
              submit: (v) => startRun(script.path, v ? [v] : []),
            })
          : startRun(script.path)
      if (key.return) return setFocus('main')
    }
    if (collRow) {
      const c = openColl(ctx, collRow.meta)
      if (key.return && focus === 'side') return setFocus('main')
      if (key.return && tab === 'Records' && !recordOpen && records?.length)
        return (setRecordOpen(true), setPScroll(0))
      const fileRow = tab === 'Files' ? detail?.d.assets?.[fCursor] : undefined
      if (fileRow && key.return) return void openAsset(c, fileRow)
      if (fileRow && input === 'w') return void saveAsset(c, fileRow)
      if (focus === 'main' && (key.leftArrow || key.rightArrow)) {
        const i = TABS.indexOf(tab)
        return setTab(TABS[(i + (key.rightArrow ? 1 : TABS.length - 1)) % TABS.length]!)
      }
      if (/^[1-5]$/.test(input)) return setTab(TABS[Number(input) - 1]!)
      if (input === 'l')
        return void attempt(`Pulling ${collRow.key}`, async () => {
          const r = await pull(ctx, c)
          void refreshRemotes()
          return `${collRow.key}: ${r.fetched} new versions${r.replayed.length ? `, ${r.replayed.length} replayed on top` : ''}`
        })
      if (input === 'u')
        return void attempt('Undoing', async () => {
          const s = await undo(c)
          return `Dropped ${s.commit.semver}`
        })
      if (input === 'S' && tab === 'Versions')
        return void attempt('Squashing', async () => {
          const s = await squash(c, undefined, null, ctx.env.now())
          return s ? `Squashed into ${s.commit.semver}` : 'They cancelled out'
        })
      if (input === 'e' && tab === 'Versions')
        return void (async () => {
          const list = await unpushedOf(c)
          const last = list.at(-1)
          if (!last) return setStatus('Nothing not pushed to reword')
          setPrompt({
            label: `Message for ${last.commit.semver}`,
            value: last.commit.changes[0]?.message ?? '',
            submit: async (v) => {
              const { reword } = await import('../core/versions.js')
              await reword(c, last.commit.number, v, ctx.env.now())
              setStatus('Reworded')
            },
          })
        })()
      if (input === 'k') {
        // Choose a level; one that lets go of anything here asks first, saying how much.
        const now = collRow.meta.keep
        const levels: Record<string, Keep> = { e: 'all', d: 'records', m: 'none' }
        return setPrompt({
          label: `Keep here: e everything, d data without files, m metadata only (now ${KEEP_LABEL[now]})`,
          value: '',
          submit: async (v) => {
            const level = levels[v.trim().toLowerCase()]
            if (!level) return setStatus('Kept as it was: type e, d or m')
            if (level === now) return setStatus(`Already keeping ${KEEP_LABEL[level]}`)
            const go = () =>
              void attempt(`Keeping ${KEEP_LABEL[level]}`, async () => {
                const r = await setKeep(ctx, c, level)
                void reload()
                return `${collRow.meta.name}: ${KEEP_LABEL[level]}${r.fetched ? `, fetched ${r.fetched}` : ''}${r.letGo ? `, let go of ${r.letGo} files here` : ''}`
              })
            const w = await wouldLetGo(c, level)
            if (!w.records && !w.assets) return go()
            const what = [
              w.records ? `${w.records} record files (${bytes(w.recordBytes)})` : '',
              w.assets ? `${w.assets} assets (${bytes(w.assetBytes)})` : '',
            ]
              .filter(Boolean)
              .join(' and ')
            setPrompt({
              label: `Delete ${what} from this machine? They stay on ${collRow.meta.authority}. y to delete`,
              value: '',
              submit: (y) => (y.trim().toLowerCase() === 'y' ? go() : setStatus('Kept as it was')),
            })
          },
        })
      }
      if (input === 'n' && tab === 'Records' && records?.length) {
        const last = records.at(-1)!
        return void loadRecords(ctx, collRow.meta, { type: last.type, id: last.id }, 200).then(
          (r) => setRecords(r.length ? r : records),
        )
      }
      if (input === 'R') {
        const writers = (snap?.scripts ?? []).filter((s) =>
          s.writes.some((w) => namesKey(w, collRow.key)),
        )
        if (writers.length === 1) return startRun(writers[0]!.path)
        if (!writers.length) return setStatus('No script declares that it writes this collection')
        return setPrompt({
          label: `Which script: ${writers.map((w) => w.name).join(', ')}`,
          value: writers[0]!.name,
          submit: (v) => startRun(findScript(ctx, v).path),
        })
      }
      if (input === 'o') {
        if (isLocal(collRow.meta)) return setStatus(`${collRow.key} is on this machine only`)
        const url = `${c.remote().url}/${collRow.meta.org}/${collRow.meta.name}`
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
          stdio: 'ignore',
          detached: true,
        }).unref()
        return setStatus(`Opened ${url}`)
      }
      if (input === 'a' || input === 'A')
        return handoff(input === 'A', { kind: 'collection', key: collRow.key })
      if (input === 'D') {
        // Typing its name confirms; "lose them" when versions not pushed would go with it.
        const m = collRow.meta
        const versions = detail?.key === collRow.key ? detail.d.versions : []
        const waiting = versions.filter((v) => !v.pushed)
        const lose = m.isNew ? versions.length > 0 : waiting.length > 0
        const name = m.isNew && !isLocal(m) ? `${m.org}/${m.name}` : m.name
        const want = lose ? 'lose them' : m.name
        const label = isLocal(m)
          ? `Delete ${name}? It is on this machine only${lose ? ', so everything in it is lost' : ''}. Type ${want} to delete it`
          : !lose
            ? `Remove ${name} from this machine? It stays on ${m.authority}. Type ${want} to remove it`
            : m.isNew
              ? `Remove ${name}? It was never pushed, so everything in it is lost. Type ${want} to remove it`
              : `Remove ${name}? Its version${waiting.length === 1 ? '' : 's'} not pushed (${waiting
                  .map((v) => v.semver)
                  .reverse()
                  .join(
                    ', ',
                  )}) ${waiting.length === 1 ? 'is' : 'are'} lost: ${waiting.length === 1 ? "it isn't" : "they aren't"} on ${m.authority}. Type ${want} to remove it`
        return setPrompt({
          label,
          value: '',
          loud: lose,
          submit: (typed) => {
            if (typed.trim() !== want) return setStatus(`Kept ${name}`)
            void attempt(`Removing ${name}`, async () => {
              await removeCollection(ctx, c, lose)
              await reload()
              goPane('collections')
              return m.isNew
                ? `Removed ${name} from this machine`
                : `Removed ${name} from this machine; Servers (s) adds it again from ${m.authority}`
            })
          },
        })
      }
    }
  }
  useInput(onKey)

  // --- The mouse, as in Hopper: click to focus and select, hover, the wheel ---

  /** A key cap clicked: what pressing that key does. */
  const clickKey = (k: string) => {
    const none = {} as InkKey
    if (k === 'enter') return onKey('', { ...none, return: true })
    if (k === 'esc') return onKey('', { ...none, escape: true })
    if (k === 'tab') return onKey('', { ...none, tab: true })
    if (k === 'space') return onKey(' ', none)
    if ([...k].length === 1) return onKey(k, none)
  }

  function onMouse(events: MouseEvent[]) {
    const g = geo.current
    for (const ev of events) {
      const up = ev.kind === 'wheel-up'
      const wheel = up || ev.kind === 'wheel-down'
      if (help) {
        if (wheel) {
          const { top, max } = helpAt.current
          setHelp({ ...help, scroll: Math.max(0, Math.min(max, top + (up ? -3 : 3))) })
        }
        continue
      }
      if (g.mode === 'settings') {
        const n = g.count
        if (wheel)
          setSettings((st) => ({
            ...st,
            cursor: Math.max(0, Math.min(n - 1, st.cursor + (up ? -1 : 1))),
          }))
        else if (ev.kind === 'press' && ev.x <= g.listW && settings.editing === null) {
          const i = g.start + ev.y - 2
          if (i >= 0 && i < n) setSettings((st) => ({ ...st, cursor: i }))
        }
        continue
      }
      if (g.mode !== 'main') continue
      const inSide = ev.x <= g.sideW
      const card = inSide ? g.cards.find((c) => ev.y >= c.top && ev.y < c.top + c.h) : undefined
      // The line under the pointer: content starts on the line after a card's top edge.
      const lineIn = (lines: Line[], start: number, top: number) => {
        const i = ev.y - top - 1
        return i >= 0 ? lines[start + i] : undefined
      }
      if (ev.kind === 'move') {
        const h = (card && lineIn(card.lines, card.start, card.top)?.item) ?? null
        setHover((cur) => (cur === h ? cur : h))
        continue
      }
      if (wheel) {
        if (card) {
          const items = (side?.items ?? []).filter((i) => paneOf(itemId(i)) === card.card)
          const at = items.findIndex((i) => itemId(i) === sel)
          const next = items[Math.max(0, Math.min(items.length - 1, at + (up ? -1 : 1)))]
          if (next && !overlay) setSel(itemId(next))
        } else if (!inSide && collRow && !overlay) {
          const text = tab === 'Overview' || tab === 'Schemas' || recordOpen
          moveInPane((up ? -1 : 1) * (text ? 3 : 1))
        } else if (!inSide && shownRun)
          setScroll((x) => (up ? Math.min(runLog.lines.length, x + 3) : Math.max(0, x - 3)))
        continue
      }
      if (ev.kind !== 'press') continue
      if (card) {
        // A screen that takes letters (push, a form, a file) keeps the keys until esc.
        if (overlay && overlay !== 'runs' && typeof overlay !== 'object') continue
        const it = lineIn(card.lines, card.start, card.top)?.item
        if (it) {
          setSel(it)
          setOverlay(null)
          setFocus('side')
          setScroll(0)
        } else goPane(card.card)
        continue
      }
      if (inSide) continue
      // The main pane: a click gives it the keys, then a version, a tab, or a key cap.
      setFocus('main')
      const l = lineIn(g.pane.lines, g.pane.start, 1)
      if (!l) continue
      if (l.act?.startsWith('version:')) {
        setVCursor(Number(l.act.slice('version:'.length)))
        continue
      }
      if (l.act?.startsWith('record:')) {
        setRCursor(Number(l.act.slice('record:'.length)))
        continue
      }
      if (l.act?.startsWith('file:')) {
        setFCursor(Number(l.act.slice('file:'.length)))
        continue
      }
      let x = g.pane.left + 2
      for (const sg of l.segs) {
        const w = [...sg.t].length
        if (ev.x >= x && ev.x < x + w) {
          const t = sg.t.trim()
          if (sg.bg === C.cap) clickKey(t)
          else if (collRow && !overlay && (TABS as readonly string[]).includes(t)) setTab(t as Tab)
          break
        }
        x += w
      }
    }
  }

  // --- Layout ---

  if (!snap || !side) return <Text color={C.mu}>Reading {tildePath(ctx.env, ctx.home.root)}…</Text>

  const sideW = sideWidth(columns)
  const mainW = Math.max(40, columns - sideW - 1)
  const pane: Pane = (() => {
    const inner = mainW - 4
    if (overlay === 'new' && newForm) return newPane(newForm, newProblem(newForm), inner)
    if (overlay === 'push') return pushPane(push_, side.user, inner)
    if (overlay === 'pick') return pickPane(pick, inner)
    if (overlay === 'file' && file) return filePane(file, inner)
    if (overlay === 'runs') return runsPane(snap.runs, runsCursor)
    if (shownRun)
      return runPane(
        shownRun,
        runLog.id === shownRun.id ? runLog.lines : [],
        scroll,
        rows - 6,
        inner,
      )
    if (collRow)
      return collectionPane(
        collRow,
        detail?.key === collRow.key ? detail.d : null,
        tab,
        {
          ...(records ? { records } : {}),
          ...(diff ? { diff } : {}),
          scripts: snap.scripts,
          storeRoot: tildePath(ctx.env, openColl(ctx, collRow.meta).store.root),
          url: isLocal(collRow.meta) ? '' : openColl(ctx, collRow.meta).remote().url,
          behind: behind[collRow.key] ?? 0,
          handoff: !!ctx.settings.handoffSend,
          vCursor,
          rCursor,
          recordOpen,
          fCursor,
        },
        inner,
      )
    if (script?.kind === 'view')
      return viewPane(script, served.current.get(script.path) ?? null, inner)
    if (script) return scriptPane(script, inner)
    if (item?.kind === 'remote') {
      const r = snap.remotes.find((x) => x.name === item.name)!
      return messagePane(
        item.name,
        r.signedIn
          ? `Signed in. Enter opens its list: your orgs' collections and public ones, to add here with all data or metadata only.`
          : `Signed out. Run \`underlay login ${item.name}\` in a terminal with a key from ${r.url}/settings/keys. Public collections can be added without signing in: enter opens its list.`,
        inner,
        [
          { k: 'enter', l: 'open its list' },
          { k: 'esc', l: 'back' },
        ],
      )
    }
    return messagePane(
      'Underlay',
      'Nothing here yet. + starts a new collection; Servers (s), then enter on one, adds collections from it; f adds a file. Scripts go in your home’s scripts/ or a script folder (underlay sources add).',
      inner,
    )
  })()

  const bodyH = Math.max(10, rows - 3)
  const remotesH = side.remotes.length + 2
  const scriptsH = Math.min(side.scripts.length, Math.max(3, Math.floor(bodyH / 4))) + 2
  const colsH = Math.max(4, bodyH - remotesH - scriptsH)
  const selLine = (lines: Line[]) =>
    Math.max(
      0,
      lines.findIndex((l) => l.bg === C.sel),
    )
  const footer = pane.footer ?? []
  const paneRows = bodyH - 2 - footer.length
  // Hover lights a sidebar row more faintly than the selection.
  const lit2 = (ls: Line[]) =>
    hover ? ls.map((l) => (l.item === hover && l.bg !== C.sel ? { ...l, bg: C.hover } : l)) : ls
  // Every line; the window below keeps the selected one in view, so a long pane scrolls to it.
  const paneLines = pane.lines
  // A pane of text scrolls by pScroll; a list keeps its selected row in view.
  paneMax.current = pane.scrolls ? Math.max(0, paneLines.length - paneRows) : 0
  const paneStart = pane.scrolls
    ? Math.min(pScroll, paneMax.current)
    : windowStart(paneLines.length, paneRows, selLine(paneLines))
  geo.current = {
    mode: 'main',
    sideW,
    cards: [
      { card: 'servers', top: 1, h: remotesH, lines: side.remotes, start: 0 },
      {
        card: 'collections',
        top: 1 + remotesH,
        h: colsH,
        lines: side.cols,
        start: windowStart(side.cols.length, colsH - 2, selLine(side.cols)),
      },
      {
        card: 'scripts',
        top: 1 + remotesH + colsH,
        h: scriptsH,
        lines: side.scripts,
        start: windowStart(side.scripts.length, scriptsH - 2, selLine(side.scripts)),
      },
    ],
    pane: {
      left: sideW + 2,
      lines: paneLines,
      start: paneStart,
    },
  }
  const globalKeys: Key[] = [
    { k: 'c', l: 'collections' },
    { k: 's', l: 'servers' },
    { k: 'r', l: 'scripts' },
    { k: '+', l: 'new' },
    { k: 'P', l: 'push all' },
    { k: 'h', l: 'runs' },
    { k: 'f', l: 'file' },
    { k: ',', l: 'settings' },
    { k: '?', l: 'keys' },
    { k: 'x x', l: 'quit' },
  ]
  const userNote = side.user ?? ''
  // The card that has the keys is drawn lit, as Hopper's are.
  const lit = (p: SidePane) => focus === 'side' && !overlay && card === p
  const statusLine = prompt ? (
    <Text wrap="truncate-end">
      <Text color={prompt.loud ? C.rd : C.bl}>{prompt.label}: </Text>
      <Text color={C.wh}>{prompt.value}▏</Text>
    </Text>
  ) : status ? (
    <Text wrap="truncate-end" color={C.or}>
      {status}
    </Text>
  ) : (
    <Text> </Text>
  )

  if (help) {
    const v = helpView(
      help.from,
      {
        version: FULL_VERSION,
        home: tildePath(ctx.env, ctx.home.root),
        config: tildePath(ctx.env, personalPath(ctx.env)),
        mascot: mascotOn(ctx.env, { isTTY: true }),
      },
      columns - 4,
      bodyH - 2,
      help.scroll,
    )
    helpAt.current = { top: v.top, max: v.maxScroll }
    geo.current = { mode: 'help' }
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Frame
          title="Keys"
          meta={v.maxScroll ? 'j k scroll · any other key closes' : 'any key closes'}
          color={C.bl}
          border={C.bl}
          width={columns}
          height={bodyH}
        >
          <Box flexDirection="row" flexGrow={1}>
            {v.side ? (
              <Box flexDirection="column" width={v.sideW} marginRight={v.gap} flexShrink={0}>
                <Lines lines={v.side} width={v.sideW} />
              </Box>
            ) : null}
            {v.cols.map((col, i) => (
              <Box
                key={i}
                flexDirection="column"
                width={v.colW}
                marginLeft={i ? v.gap : 0}
                flexShrink={0}
                overflow="hidden"
              >
                <Lines lines={col} width={v.colW} />
              </Box>
            ))}
          </Box>
          <Lines lines={v.foot} width={columns - 4} />
        </Frame>
        <Text> </Text>
        <KeyBar keys={[{ k: 'any key', l: 'close' }]} width={columns} />
      </Box>
    )
  }

  if (overlay === 'settings') {
    const items = settingsItems(settings.rows)
    const cursor = Math.min(settings.cursor, Math.max(0, items.length - 1))
    const listW = Math.max(40, Math.round(columns * 0.58))
    const aboutW = columns - listW
    const list = settingsList(items, cursor, settings.editing)
    geo.current = {
      mode: 'settings',
      listW,
      count: items.length,
      start: windowStart(list.length, bodyH - 2, cursor),
    }
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Box flexDirection="row" height={bodyH}>
          <Frame
            title="Settings"
            meta="esc closes"
            color={C.bl}
            border={C.bl}
            width={listW}
            height={bodyH}
          >
            <Lines lines={windowed(list, bodyH - 2, cursor)} width={listW - 4} />
          </Frame>
          <Frame title="About" color={C.mu} width={aboutW} height={bodyH}>
            <Lines
              lines={settingsAbout(
                items[cursor],
                tildePath(ctx.env, personalPath(ctx.env)),
                aboutW - 4,
                settings.editing !== null,
              )}
              width={aboutW - 4}
            />
          </Frame>
        </Box>
        {statusLine}
        <KeyBar keys={settingsKeys(items[cursor], settings.editing !== null)} width={columns} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexDirection="row" height={bodyH} columnGap={1}>
        <Box flexDirection="column" width={sideW}>
          <Frame
            title="Servers"
            keyHint="s"
            meta={userNote}
            color={lit('servers') ? C.bl : C.mu}
            border={lit('servers') ? C.bl : C.dim}
            width={sideW}
            height={remotesH}
          >
            <Lines lines={lit2(side.remotes)} width={sideW - 4} />
          </Frame>
          <Frame
            title="Collections on this machine"
            keyHint="c"
            {...(lit('collections') ? { meta: '+ new' } : {})}
            color={lit('collections') ? C.bl : C.mu}
            border={lit('collections') ? C.bl : C.dim}
            width={sideW}
            height={colsH}
          >
            <Lines
              lines={windowed(lit2(side.cols), colsH - 2, selLine(side.cols))}
              width={sideW - 4}
            />
          </Frame>
          <Frame
            title="Scripts and views"
            keyHint="r"
            color={lit('scripts') ? C.bl : C.mu}
            border={lit('scripts') ? C.bl : C.dim}
            width={sideW}
            height={scriptsH}
          >
            <Lines
              lines={windowed(lit2(side.scripts), scriptsH - 2, selLine(side.scripts))}
              width={sideW - 4}
            />
          </Frame>
        </Box>
        <Frame
          title={pane.title}
          {...(pane.meta ? { meta: pane.meta } : {})}
          // Lit when it has the keys, as the cards are; push and the like keep their own colour.
          color={pane.color ?? (focus === 'main' ? C.bl : C.fg)}
          border={pane.border ?? (focus === 'main' ? C.bl : C.dim)}
          width={mainW}
          height={bodyH}
        >
          <Box flexDirection="column" flexGrow={1}>
            <Lines lines={paneLines.slice(paneStart, paneStart + paneRows)} width={mainW - 4} />
          </Box>
          {footer.length ? <Lines lines={footer} width={mainW - 4} /> : null}
        </Frame>
      </Box>
      {prompt ? (
        <Text wrap="truncate-end">
          <Text color={prompt.loud ? C.rd : C.bl}>{prompt.label}: </Text>
          <Text color={C.wh}>{prompt.value}▏</Text>
        </Text>
      ) : status ? (
        <Text wrap="truncate-end" color={C.or}>
          {status}
        </Text>
      ) : updateOut ? (
        <Text wrap="truncate-end" color={C.bl}>
          A newer Underlay CLI is out: quit (q) and run underlay update
        </Text>
      ) : (
        <Text> </Text>
      )}
      <KeyBar
        keys={[...pane.keys, ...globalKeys.filter((g) => !pane.keys.some((k) => k.k === g.k))]}
        width={columns}
      />
    </Box>
  )
}
