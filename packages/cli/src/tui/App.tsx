/**
 * The terminal UI (local-tool-build.md phase 5): a sidebar of three cards (Remotes, On this
 * machine, Scripts and views) beside one main pane, with a key bar along the bottom. It calls
 * the library directly and watches the workspace, so what an agent or another terminal does
 * shows up as it happens. Runs start detached, so closing the UI never stops one.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'

import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { addCollection, forget, keep, type RemoteListing } from '../core/collections.js'
import { listPublic } from '../core/collections.js'
import {
  getSetting,
  personalPath,
  removeRule,
  setRule,
  setSetting,
  SETTINGS,
  workspaceConfigPath,
} from '../core/config.js'
import { type Ctx, openColl } from '../core/context.js'
import { CliError, tildePath } from '../core/env.js'
import { diffVersions } from '../core/format.js'
import { copyText, handoffPrompt, type HandoffTarget, sendHandoff } from '../core/handoff.js'
import { addFile, defaultOptions, eject, readTable, saveImport } from '../core/importers.js'
import { readRun, type RunRecord, signalRun, startDetached } from '../core/runs.js'
import { findScript } from '../core/scripts.js'
import { pull, push, pushPlan, StaleError } from '../core/sync.js'
import { squash, undo, unpushedOf, cidOf } from '../core/versions.js'
import { parseRef } from '../core/workspace.js'
import {
  type CollectionDetail,
  loadBehind,
  loadCollection,
  loadRecords,
  loadRemote,
  loadSnapshot,
  type Snapshot,
} from './data.js'
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
  settingsPane,
  sidebar,
  type Tab,
  TABS,
  viewPane,
} from './screens.js'

type Overlay = null | 'push' | 'pick' | 'settings' | 'file' | 'runs' | { run: string }

interface Prompt {
  label: string
  value: string
  submit: (v: string) => void | Promise<void>
}

const lineText = (l: Line) => l.segs.map((s) => s.t).join('')

function Lines({ lines, width }: { lines: Line[]; width: number }) {
  return (
    <>
      {lines.map((l, i) => {
        const text = lineText(l)
        return (
          <Text key={i} wrap="truncate-end">
            {text === '' ? ' ' : null}
            {l.segs.map((s, j) =>
              s.t ? (
                <Text
                  key={j}
                  color={s.c ?? C.fg}
                  bold={!!s.b}
                  {...((s.bg ?? l.bg) ? { backgroundColor: s.bg ?? l.bg } : {})}
                >
                  {s.t}
                </Text>
              ) : null,
            )}
            {l.bg ? (
              <Text backgroundColor={l.bg}>{' '.repeat(Math.max(0, width - text.length))}</Text>
            ) : null}
          </Text>
        )
      })}
    </>
  )
}

/** A card: a rounded box whose top edge carries its title, as a fieldset's legend. */
function Frame(props: {
  title: string
  meta?: string
  color?: string
  border?: string
  width: number
  height: number
  children?: ReactNode
}) {
  const { title, meta, color, border, width, height, children } = props
  const edge = border ?? C.dim
  const head = ` ${title} `
  const room = Math.max(0, width - 4 - head.length)
  const note =
    meta && room > 6 ? ` ${meta.length > room - 3 ? meta.slice(0, room - 4) + '…' : meta} ` : ''
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={edge}>╭─</Text>
        <Text color={color ?? C.fg} bold>
          {head}
        </Text>
        <Text color={C.mu}>{note}</Text>
        <Text color={edge}>{'─'.repeat(Math.max(0, room - note.length)) + '─╮'}</Text>
      </Text>
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderTop={false}
        borderColor={edge}
        paddingX={1}
        overflowY="hidden"
      >
        {children}
      </Box>
    </Box>
  )
}

/** The lines that fit, keeping a line in view. */
function windowed(lines: Line[], rows: number, keep: number): Line[] {
  if (lines.length <= rows) return lines
  const start = Math.min(Math.max(0, keep - Math.floor(rows / 2)), lines.length - rows)
  return lines.slice(start, start + rows)
}

function KeyBar({ keys, width }: { keys: Key[]; width: number }) {
  return (
    <Box width={width} flexWrap="wrap" columnGap={2}>
      {keys.map((k, i) => (
        <Text key={i} color={C.mu}>
          <Text color={C.fg} bold>
            {k.k}
          </Text>{' '}
          {k.l}
        </Text>
      ))}
    </Box>
  )
}

const settingRows = (ctx: Ctx): SettingRow[] => {
  const root = ctx.ws.root
  const rows: SettingRow[] = []
  for (const d of SETTINGS) {
    const v = getSetting(ctx.env, root, d.key)
    const group = d.group === 'Remotes' ? 'Remotes' : d.group
    rows.push({
      group,
      key: d.key,
      label: d.key.split('.').slice(1).join('.') || d.key,
      value: v.value,
      from: v.from,
      about: d.about,
      kind: 'setting',
    })
  }
  rows.splice(1, 0, {
    group: 'Workspace',
    key: '',
    label: 'this workspace',
    value: tildePath(ctx.env, root),
    from: 'here',
    about: 'collections, scripts, views',
    kind: 'info',
  })
  for (const r of ctx.settings.rules)
    rows.push({
      group: 'Rules',
      key: r.match,
      label: r.match,
      value: [r.path ? `path ${tildePath(ctx.env, r.path)}` : '', r.keep ? `keep ${r.keep}` : '']
        .filter(Boolean)
        .join(', '),
      from: r.from,
      about: 'most specific match wins',
      kind: 'rule',
    })
  for (const r of ctx.settings.remotes) {
    const v = getSetting(ctx.env, root, `remotes.${r.name}.url`)
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
  const order = ['Workspace', 'Store', 'Rules', 'Remotes', 'Handoff', 'Serve']
  return rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
}

export function App({ ctx, initial }: { ctx: Ctx; initial?: { sel?: string } }) {
  const { exit, suspendTerminal } = useApp()
  const size = useWindowSize()
  const columns = size.columns || 120
  const rows = size.rows || 40
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [remotes, setRemotes] = useState<Record<string, RemoteListing | { error: string }>>({})
  const [behind, setBehind] = useState<Record<string, number>>({})
  const [sel, setSel] = useState(initial?.sel ?? '')
  const [focus, setFocus] = useState<'side' | 'main'>('side')
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [tab, setTab] = useState<Tab>('Overview')
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
  const [runsCursor, setRunsCursor] = useState(0)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [status, setStatus] = useState('')
  const reloadSoon = useRef<NodeJS.Timeout | null>(null)
  const tick = useRef(0)

  const attempt = useCallback(async (what: string, work: () => Promise<string | void>) => {
    setStatus(`${what}…`)
    try {
      const done = await work()
      setStatus(done ?? '')
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
      setStatus(`Reading the workspace: ${(err as Error).message}`)
    }
  }, [ctx])

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
    for (const dir of [ctx.ws.root, ctx.settings.storePath]) {
      try {
        watchers.push(
          watch(dir, { recursive: true }, (_e, name) => {
            if (
              name &&
              (name.startsWith('.git') ||
                name.includes('/tmp/') ||
                name.startsWith('tmp/') ||
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
    () =>
      snap
        ? sidebar(
            snap,
            remotes,
            behind,
            sel,
            Math.min(40, Math.max(30, Math.floor(columns * 0.27))),
          )
        : null,
    [snap, remotes, behind, sel, columns],
  )
  useEffect(() => {
    if (side && !side.items.some((i) => itemId(i) === sel)) {
      const first = side.items.find((i) => i.kind === 'coll') ?? side.items[0]
      if (first) setSel(itemId(first))
    }
  }, [side, sel])

  const item = side?.items.find((i) => itemId(i) === sel) ?? null
  const collRow =
    item?.kind === 'coll' ? (snap?.collections.find((c) => c.key === item.key) ?? null) : null
  const script =
    item?.kind === 'script' ? (snap?.scripts.find((s) => s.path === item.path) ?? null) : null
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
    setPush((v) => ({ ...v, busy: true, typed: '' }))
    const progress: string[] = []
    const note = (t: string) => {
      progress.push(t)
      setPush((v) => ({ ...v, progress: [...progress] }))
    }
    for (const p of chosen) {
      try {
        await push(ctx, p.coll, note)
      } catch (err) {
        note(
          err instanceof StaleError
            ? err.message.split('\n').join(' ')
            : `${p.coll.key}: ${(err as Error).message}`,
        )
      }
    }
    setPush((v) => ({ ...v, busy: false, plans: [] }))
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
    for (const [name, k] of chosen) {
      setPick((v) => ({ ...v, status: `Adding ${name}…` }))
      try {
        await addCollection(ctx, `${pick.remote}/${name}`, { keep: k })
      } catch (err) {
        setPick((v) => ({ ...v, status: `${name}: ${(err as Error).message}` }))
        return
      }
    }
    const l = await loadRemote(ctx, pick.remote)
    setPick((v) => ({ ...v, selected: new Map(), status: `Added ${chosen.length}`, listing: l }))
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
          const meta = ctx.ws.collection(parseRef(target, ctx.settings.defaultRemote))
          const type = m?.type ?? Object.keys(ctx.ws.schemas(meta))[0] ?? 'Record'
          const t = await readTable(
            join(ctx.ws.root, shape.path),
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

    // The push screen takes typing.
    if (overlay === 'push') {
      if (key.escape) return (setOverlay(null), setFocus('side'))
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
      const p = push_.plans[push_.cursor]
      if (input === 'd' && p)
        return (setOverlay(null), setSel(`c:${p.coll.key}`), setTab('Changes'))
      if (input === 's' && p)
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
      if (key.escape) return (setOverlay(null), setFocus('side'))
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
      if (s.editing !== null) {
        if (key.escape) return setSettings({ ...s, editing: null })
        if (key.return) {
          const row = s.rows[s.cursor]!
          try {
            if (row.kind === 'rule') {
              const keepM = /keep (all|some|none)/.exec(s.editing)?.[1]
              const pathM = /path ([^,]+)/.exec(s.editing)?.[1]?.trim()
              setRule(ctx.env, ctx.ws.root, {
                match: row.key,
                ...(pathM ? { path: pathM } : {}),
                ...(keepM ? { keep: keepM as 'all' } : {}),
              })
            } else setSetting(ctx.env, ctx.ws.root, row.key, s.editing)
            setStatus(`${row.label} saved`)
          } catch (err) {
            setStatus((err as Error).message)
          }
          void reload()
          return setSettings({ rows: settingRows(ctx), cursor: s.cursor, editing: null })
        }
        if (key.backspace || key.delete)
          return setSettings((x) => ({ ...x, editing: (x.editing ?? '').slice(0, -1) }))
        if (input) return setSettings((x) => ({ ...x, editing: (x.editing ?? '') + input }))
        return
      }
      if (key.escape) return (setOverlay(null), setFocus('side'))
      if (key.upArrow) return setSettings({ ...s, cursor: Math.max(0, s.cursor - 1) })
      if (key.downArrow)
        return setSettings({ ...s, cursor: Math.min(s.rows.length - 1, s.cursor + 1) })
      const row = s.rows[s.cursor]
      if (key.return && row && row.kind !== 'info')
        return setSettings({ ...s, editing: row.from === 'default' ? '' : row.value })
      if (input === 'd' && row) {
        if (row.kind === 'rule') removeRule(ctx.env, ctx.ws.root, row.key)
        else if (row.kind !== 'info') setSetting(ctx.env, ctx.ws.root, row.key, undefined)
        void reload()
        return setSettings({ ...s, rows: settingRows(ctx) })
      }
      if (input === 'a')
        return setPrompt({
          label:
            'New rule: authority/org/name (with * at the end), then path and keep, e.g. underlay.org/mitp/* keep all',
          value: '',
          submit: (v) => {
            const [match, ...rest] = v.trim().split(/\s+/)
            if (!match) return
            const words = rest.join(' ')
            const k = /keep (all|some|none)/.exec(words)?.[1] as 'all' | undefined
            const p = /path (\S+)/.exec(words)?.[1]
            setRule(ctx.env, ctx.ws.root, {
              match,
              ...(p ? { path: p } : {}),
              ...(k ? { keep: k } : {}),
            })
            setSettings((x) => ({ ...x, rows: settingRows(ctx) }))
          },
        })
      if (input === 'o')
        return void editInEditor(
          row?.from === 'workspace' ? workspaceConfigPath(ctx.ws.root) : personalPath(ctx.env),
        )
      return
    }

    if (overlay === 'file' && file) {
      if (key.escape) return (setOverlay(null), setFocus('side'))
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
            ctx.ws.schemas(parseRef(o.collection, ctx.settings.defaultRemote)),
          )
          if (types.length) next.type = cycle(types, o.type)
        }
        if (f === 'id') next.id = cycle(t.columns, o.id)
        if (f === 'missing_id') next.missing_id = o.missing_id === 'hold' ? 'skip' : 'hold'
        if (f === 'mode') next.mode = o.mode === 'set' ? 'additions' : 'set'
        if (f === 'sheet' || f === 'collection' || f === 'id' || f === 'type') {
          // Columns follow the sheet and the schema.
          void readTable(join(ctx.ws.root, file.shape.path), {
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
          setStatus(`Wrote ${eject(ctx, findScript(ctx.ws, rel))}`)
        } catch (err) {
          setStatus((err as Error).message)
        }
        return void reload()
      }
      if (input === 'c' || input === 'C')
        return handoff(input === 'C', { kind: 'file', shape: file.shape })
      return
    }

    if (overlay === 'runs') {
      const runs = snap?.runs ?? []
      if (key.escape) return (setOverlay(null), setFocus('side'))
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
        return startRun(shownRun.script, shownRun.args)
      }
      if (!live && input === 'u' && shownRun.saved.length)
        return void attempt('Undoing this run', async () => {
          const undone: string[] = []
          for (const s of shownRun.saved) {
            const meta = ctx.ws.resolve(s.collection)
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
      if (input === 'c' || input === 'C')
        return handoff(input === 'C', { kind: 'run', run: readRun(ctx, shownRun.id) })
      if (key.escape && overlay) return (setOverlay(null), setFocus('side'))
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
    if (input === '+')
      return void openPick(item?.kind === 'remote' ? item.name : ctx.settings.defaultRemote)
    if (input === 'h') return (setRunsCursor(0), setOverlay('runs'), setFocus('main'))
    if (input === 'f')
      return setPrompt({
        label: 'A file to add (or drop one on the terminal)',
        value: '',
        submit: (v) => openFile(v),
      })
    if (key.escape) return (setOverlay(null), setFocus('side'))
    if (key.tab) return setFocus((f) => (f === 'side' ? 'main' : 'side'))

    // Up and down move through the sidebar, wherever the keys are.
    if (key.upArrow || key.downArrow) {
      const items = side?.items ?? []
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
    if (item?.kind === 'view' && input === 'v') {
      const p = join(ctx.ws.root, 'views', item.name, 'index.html')
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [p], {
        stdio: 'ignore',
        detached: true,
      }).unref()
      return setStatus(`Opened ${p}`)
    }
    if (script) {
      if (input === 'r')
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
      if (input === 's' && tab === 'Versions')
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
            const types = Object.keys(ctx.ws.schemas(collRow.meta)).slice(0, 1)
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
      if (input === 'r') {
        const writers = (snap?.scripts ?? []).filter((s) =>
          s.writes.some((w) => w === collRow.key || collRow.key.endsWith('/' + w)),
        )
        if (writers.length === 1) return startRun(writers[0]!.path)
        if (!writers.length) return setStatus('No script declares that it writes this collection')
        return setPrompt({
          label: `Which script: ${writers.map((w) => w.name).join(', ')}`,
          value: writers[0]!.name,
          submit: (v) => startRun(findScript(ctx.ws, v).path),
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
      if (input === 'c' || input === 'C')
        return handoff(input === 'C', { kind: 'collection', key: collRow.key })
    }
  })

  // --- Layout ---

  if (!snap || !side) return <Text color={C.mu}>Reading {tildePath(ctx.env, ctx.ws.root)}…</Text>

  const sideW = Math.min(40, Math.max(30, Math.floor(columns * 0.27)))
  const mainW = Math.max(40, columns - sideW - 1)
  const pane: Pane = (() => {
    const inner = mainW - 4
    if (overlay === 'push') return pushPane(push_, side.user, inner)
    if (overlay === 'pick') return pickPane(pick, inner)
    if (overlay === 'settings')
      return settingsPane(settings.rows, settings.cursor, settings.editing, inner)
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
    if (script) return scriptPane(script, inner)
    if (item?.kind === 'view')
      return viewPane(item.name, ctx.ws.root, ctx.settings.servePort, inner)
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
      'Nothing here yet. + adds collections from a remote; f adds a file; scripts go in scripts/.',
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
    { k: 'q', l: 'quit' },
  ]
  const userNote = side.user ?? ''
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexDirection="row" height={bodyH} columnGap={1}>
        <Box flexDirection="column" width={sideW}>
          <Frame title="Remotes" meta={userNote} color={C.mu} width={sideW} height={remotesH}>
            <Lines lines={side.remotes} width={sideW - 4} />
          </Frame>
          <Frame
            title="On this machine"
            color={focus === 'side' ? C.bl : C.mu}
            border={focus === 'side' ? C.bl : C.dim}
            width={sideW}
            height={colsH}
          >
            <Lines lines={windowed(side.cols, colsH - 2, selLine(side.cols))} width={sideW - 4} />
          </Frame>
          <Frame title="Scripts and views" color={C.mu} width={sideW} height={scriptsH}>
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
