/**
 * The terminal UI (local-tool-build.md phase 5): a sidebar of three cards (Remotes, On this
 * machine, Scripts and views) beside one main pane, with a key bar along the bottom. It calls
 * the library directly and watches home and the script folders, so what an agent or another terminal does
 * shows up as it happens. Runs start detached, so closing the UI never stops one.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, watch } from 'node:fs'

import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { addCollection, forget, keep, type RemoteListing } from '../core/collections.js'
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
} from '../core/config.js'
import { type Ctx, openColl } from '../core/context.js'
import { CliError, tildePath } from '../core/env.js'
import { diffVersions } from '../core/format.js'
import { copyText, handoffPrompt, type HandoffTarget, sendHandoff } from '../core/handoff.js'
import { parseRef } from '../core/home.js'
import { addFile, defaultOptions, eject, readTable, saveImport } from '../core/importers.js'
import { inputPath, readRun, type RunRecord, signalRun, startDetached } from '../core/runs.js'
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
import { Frame, KeyBar, Lines, windowed } from './frame.js'
import { helpView, type Section } from './help.js'
import { C, type Key, type Line, type Pane } from './lines.js'
import {
  collectionPane,
  FILE_FIELDS,
  type FileView,
  filePane,
  itemId,
  messagePane,
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

type Overlay = null | 'push' | 'pick' | 'settings' | 'file' | 'runs' | { run: string }

interface Prompt {
  label: string
  value: string
  submit: (v: string) => void | Promise<void>
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
}: {
  ctx: Ctx
  initial?: { sel?: string }
  /** Titles the terminal tab "Underlay" again; tests leave it out. */
  setTitle?: () => void
}) {
  const { exit, suspendTerminal: suspendInk } = useApp()
  // An editor or pager given the terminal may retitle the tab: title it again after.
  const suspendTerminal = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await suspendInk(fn)
      } finally {
        setTitle?.()
      }
    },
    [suspendInk, setTitle],
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
    if (tab === 'Changes' && !diff) {
      const c = openColl(ctx, collRow.meta)
      const head = collRow.status.head?.number ?? 0
      const pushedTo = collRow.status.remote?.number ?? 0
      const from = pushedTo < head ? pushedTo : Math.max(0, head - 1)
      void diffVersions(c, from, head).then(
        (d) => setDiff({ ...d, from, to: head }),
        (e) => setStatus((e as Error).message),
      )
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, collVersion, records, diff])

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

  const openPush = useCallback(async () => {
    const s = await loadSnapshot(ctx)
    const plans = (
      await Promise.all(s.collections.map((c) => pushPlan(openColl(ctx, c.meta))))
    ).filter((p) => p !== null)
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
  }, [ctx])

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
    const failed = new Map<string, 'all' | 'none'>()
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
        setFile({ shape, options, field: 0, status: '' })
        setOverlay('file')
        setFocus('main')
        return ''
      })
    },
    [ctx, snap, attempt],
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
    const to = there.find((i) => itemId(i) === lastSel.current[p]) ?? there[0]
    if (!to && p === 'scripts') return setStatus('No scripts yet: put one in scripts/')
    setSel(to ? itemId(to) : '')
    setOverlay(null)
    setFocus('side')
    setScroll(0)
  }

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

  useInput((input, key) => {
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

    // The help screen: j and k scroll it; any other key closes it.
    if (help) {
      const { top, max } = helpAt.current
      if (key.downArrow || input === 'j')
        return setHelp({ ...help, scroll: Math.min(max, top + 1) })
      if (key.upArrow || input === 'k') return setHelp({ ...help, scroll: Math.max(0, top - 1) })
      return setHelp(null)
    }
    const typing =
      (overlay === 'settings' && settings.editing !== null) ||
      (overlay === 'pick' && pick.searching)
    if (input === '?' && !typing) return setHelp({ from: hereSection(), scroll: null })
    // c, s and r give a card the keys, from anywhere but the screens that take letters.
    if (!typing && (overlay === null || overlay === 'runs' || typeof overlay === 'object')) {
      if (input === 'c') return goPane('collections')
      if (input === 's') return goPane('servers')
      if (input === 'r') return goPane('scripts')
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
          await openPush()
          return said.join(' · ')
        })
      const p = push_.plans[push_.cursor]
      if (input === 'd' && p)
        return (setOverlay(null), setSel(`c:${p.coll.key}`), setTab('Changes'))
      if (input === 'S' && p)
        return void attempt('Squashing', async () => {
          const s = await squash(p.coll, undefined, null, ctx.env.now())
          await openPush()
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
            await openPush()
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
          m.set(name, m.get(name) === 'all' ? 'none' : 'all')
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
      if (key.tab || key.downArrow)
        return setFile({ ...file, field: (file.field + 1) % FILE_FIELDS.length })
      if (key.upArrow)
        return setFile({
          ...file,
          field: (file.field + FILE_FIELDS.length - 1) % FILE_FIELDS.length,
        })
      const o = file.options
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
              setFile((fv) =>
                fv
                  ? { ...fv, options: { ...d, missing_id: next.missing_id, mode: next.mode } }
                  : fv,
              )
            },
            (e) => setStatus((e as Error).message),
          )
        }
        return setFile({ ...file, options: next })
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
        return handoff(input === 'A', { kind: 'file', shape: file.shape })
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
        if (input === 'x')
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
    if (input === 'q') return exit()
    if (input === ',')
      return (
        setSettings({ rows: settingRows(ctx), cursor: 0, editing: null }),
        setOverlay('settings'),
        setFocus('main')
      )
    if (input === 'p') return void openPush()
    if (input === '+') {
      // The selected remote if you are signed in there; else your default, or the first
      // server you are signed in to. A signed-out remote's list is a dead end.
      const signedIn = (n: string) => ctx.env.keys.get(n) !== null
      const remotes = snap?.remotes.map((r) => r.name) ?? []
      const target =
        item?.kind === 'remote' && signedIn(item.name)
          ? item.name
          : signedIn(ctx.settings.defaultRemote)
            ? ctx.settings.defaultRemote
            : (remotes.find(signedIn) ?? ctx.settings.defaultRemote)
      return void openPick(target)
    }
    if (input === 'h') return (setRunsCursor(0), setOverlay('runs'), setFocus('main'))
    if (input === 'f')
      return setPrompt({
        label: 'A file to add (or drop one on the terminal)',
        value: '',
        submit: (v) => openFile(v),
      })
    if (key.escape) return goPane('collections')
    if (key.tab) return setFocus((f) => (f === 'side' ? 'main' : 'side'))

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
      if (input === 'x' && served.current.has(script.path)) {
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
      if (focus === 'main' && (key.leftArrow || key.rightArrow)) {
        const i = TABS.indexOf(tab)
        return setTab(TABS[(i + (key.rightArrow ? 1 : TABS.length - 1)) % TABS.length]!)
      }
      if (/^[1-6]$/.test(input)) return setTab(TABS[Number(input) - 1]!)
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
        const order = ['all', 'some', 'none'] as const
        const next = order[(order.indexOf(collRow.meta.keep) + 1) % 3]!
        return void attempt(`Keeping ${next}`, async () => {
          if (next === 'none') return `Let go of ${await forget(ctx, c)} files`
          if (next === 'some') {
            const types = Object.keys(ctx.home.schemas(collRow.meta)).slice(0, 1)
            return `Fetched ${await keep(ctx, c, types)} files (some: ${types.join(', ')}; underlay keep --types to choose)`
          }
          return `Fetched ${await keep(ctx, c)} files`
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
          s.writes.some((w) => w === collRow.key || collRow.key.endsWith('/' + w)),
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
        const url = `${c.remote().url}/${collRow.meta.org}/${collRow.meta.name}`
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
          stdio: 'ignore',
          detached: true,
        }).unref()
        return setStatus(`Opened ${url}`)
      }
      if (input === 'a' || input === 'A')
        return handoff(input === 'A', { kind: 'collection', key: collRow.key })
    }
  })

  // --- Layout ---

  if (!snap || !side) return <Text color={C.mu}>Reading {tildePath(ctx.env, ctx.home.root)}…</Text>

  const sideW = sideWidth(columns)
  const mainW = Math.max(40, columns - sideW - 1)
  const pane: Pane = (() => {
    const inner = mainW - 4
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
          url: openColl(ctx, collRow.meta).remote().url,
          behind: behind[collRow.key] ?? 0,
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
      'Nothing here yet. + adds collections from a remote; f adds a file; scripts go in your home’s scripts/ or a script folder (underlay sources add).',
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
  const paneLines = shownRun && !overlay ? pane.lines : pane.lines.slice(0, Math.max(0, paneRows))
  const globalKeys: Key[] = [
    { k: '+', l: 'add' },
    { k: 'p', l: 'push' },
    { k: 'h', l: 'runs' },
    { k: 'f', l: 'file' },
    { k: ',', l: 'settings' },
    { k: '?', l: 'keys' },
    { k: 'q', l: 'quit' },
  ]
  const userNote = side.user ?? ''
  // The card that has the keys is drawn lit, as Hopper's are.
  const lit = (p: SidePane) => focus === 'side' && !overlay && card === p
  const statusLine = prompt ? (
    <Text wrap="truncate-end">
      <Text color={C.bl}>{prompt.label}: </Text>
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
            <Lines lines={side.remotes} width={sideW - 4} />
          </Frame>
          <Frame
            title="Collections on this machine"
            keyHint="c"
            color={lit('collections') ? C.bl : C.mu}
            border={lit('collections') ? C.bl : C.dim}
            width={sideW}
            height={colsH}
          >
            <Lines lines={windowed(side.cols, colsH - 2, selLine(side.cols))} width={sideW - 4} />
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
              lines={windowed(side.scripts, scriptsH - 2, selLine(side.scripts))}
              width={sideW - 4}
            />
          </Frame>
        </Box>
        <Frame
          title={pane.title}
          {...(pane.meta ? { meta: pane.meta } : {})}
          {...(pane.color ? { color: pane.color } : {})}
          border={pane.border ?? (focus === 'main' ? C.fg : C.dim)}
          width={mainW}
          height={bodyH}
        >
          <Box flexDirection="column" flexGrow={1}>
            <Lines lines={windowed(paneLines, paneRows, selLine(paneLines))} width={mainW - 4} />
          </Box>
          {footer.length ? <Lines lines={footer} width={mainW - 4} /> : null}
        </Frame>
      </Box>
      {prompt ? (
        <Text wrap="truncate-end">
          <Text color={C.bl}>{prompt.label}: </Text>
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
