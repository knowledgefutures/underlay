/**
 * Views (local-tool.md "Views"): scripts too. A page (`<!-- underlay: view -->` in an .html
 * file) opens in a browser as it is. A script that declares `serves` is given a free port as
 * `PORT`, waited for until it listens, opened, and stopped when the view is closed: the
 * script never reports its own address, so ports don't clash and the tool knows what runs.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'

import type { Ctx } from './context.js'
import { CliError } from './env.js'
import type { ScriptInfo } from './scripts.js'
import { secretsFor } from './sources.js'

/** Open a URL or file in the browser. */
export function openInBrowser(target: string): void {
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], {
    stdio: 'ignore',
    detached: true,
  }).unref()
}

/** A free port on localhost, from the system. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer()
    s.unref()
    s.on('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => done(port))
    })
  })
}

const listening = (port: number) =>
  new Promise<boolean>((done) => {
    const sock = connect({ port, host: '127.0.0.1' })
    sock.once('connect', () => {
      sock.destroy()
      done(true)
    })
    sock.once('error', () => done(false))
  })

export interface ServedView {
  url: string
  port: number
  child: ChildProcess
  stop(): void
}

/**
 * Start a view that serves: run it with `PORT`, wait (up to `timeoutMs`) for it to listen.
 * Its output goes to `onOutput`. Fails if it exits or never listens.
 */
export async function serveView(
  ctx: Ctx,
  info: ScriptInfo,
  opts: { onOutput?: (text: string) => void; timeoutMs?: number; port?: number } = {},
): Promise<ServedView> {
  if (info.view !== 'server' || !info.command)
    throw new CliError(`${info.name} isn’t a view that serves`)
  const secrets = secretsFor(ctx.env, info.need, info.name)
  const port = opts.port ?? (await freePort())
  const child = spawn(info.command[0]!, info.command.slice(1), {
    cwd: info.cwd,
    env: {
      ...process.env,
      ...secrets,
      PORT: String(port),
      UNDERLAY_HOME: ctx.home.root,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let exited: number | null | undefined
  child.on('exit', (code) => (exited = code))
  child.stdout?.on('data', (b: Buffer) => opts.onOutput?.(b.toString()))
  child.stderr?.on('data', (b: Buffer) => opts.onOutput?.(b.toString()))
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-child.pid!, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  for (;;) {
    if (exited !== undefined)
      throw new CliError(
        `${info.name} exited (${exited ?? 'a signal'}) before it listened on ${port}`,
      )
    if (await listening(port)) break
    if (Date.now() > deadline) {
      stop()
      throw new CliError(
        `${info.name} didn’t listen on PORT (${port}) within ${Math.round((opts.timeoutMs ?? 30_000) / 1000)} s`,
      )
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return { url: `http://localhost:${port}/`, port, child, stop }
}
