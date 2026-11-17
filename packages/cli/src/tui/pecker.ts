/**
 * The woodpecker beside a push or pull in a plain terminal: it pecks while files go up or come
 * down, with a bar of how many. It is drawn under the lines the command prints and redrawn in
 * place; it shows only once the work has taken most of a second, so quick pushes print as they
 * always did, and it is gone when the work is done.
 */
import type { Env } from '../core/env.js'
import type { FileProgress } from '../core/sync.js'
import { birdAnsi, BIRD, type Depth, depthOf, mascotOn, PECK, visibleWidth } from './bird.js'

const TICK = 130
const DELAY = 700
const BAR = 24
const HIDE = '\x1b[?25l'
const SHOW = '\x1b[?25h'

type Out = Pick<NodeJS.WriteStream, 'write' | 'columns' | 'isTTY'>

export class Pecker {
  private drawn = 0
  private frame = 0
  private info: FileProgress | null = null
  private readonly started = Date.now()
  private readonly timer: NodeJS.Timeout
  private readonly frames: string[][]
  private readonly onSigint = () => {
    this.stop()
    process.exit(130)
  }
  private readonly onExit = () => this.out.write(SHOW)

  constructor(
    private readonly out: Out,
    depth: Depth,
  ) {
    this.frames = PECK.map((f) => birdAnsi(f, depth))
    this.timer = setInterval(() => this.redraw(true), TICK)
    this.timer.unref()
    process.once('SIGINT', this.onSigint)
    process.once('exit', this.onExit)
  }

  /** For push and pull's onFile. */
  readonly file = (p: FileProgress) => {
    this.info = p
    this.redraw(false)
  }

  /** A line the command prints: above the bird, which is drawn again under it. */
  readonly log = (line = '') => {
    this.erase()
    this.out.write(line + '\n')
    this.draw()
  }

  stop() {
    clearInterval(this.timer)
    this.erase()
    this.out.write(SHOW)
    process.off('SIGINT', this.onSigint)
    process.off('exit', this.onExit)
  }

  private redraw(step: boolean) {
    if (step) this.frame++
    this.erase()
    this.draw()
  }

  private erase() {
    if (!this.drawn) return
    this.out.write(`\x1b[${this.drawn}F\x1b[J`)
    this.drawn = 0
  }

  private draw() {
    const p = this.info
    if (!p || Date.now() - this.started < DELAY) return
    const bird = this.frames[this.frame % this.frames.length]!
    const filled = p.total ? Math.round((p.done / p.total) * BAR) : BAR
    const what =
      p.direction === 'up'
        ? `Pushing ${p.key} to ${p.authority}`
        : `Pulling ${p.key} from ${p.authority}`
    const text = [
      '',
      `\x1b[1m${what}\x1b[0m`,
      p.semver ? `\x1b[2mversion ${p.semver}\x1b[0m` : '',
      '',
      `\x1b[32m${'█'.repeat(filled)}\x1b[0m\x1b[2m${'░'.repeat(BAR - filled)}\x1b[0m  ` +
        (p.done < p.total || !p.total
          ? `${p.done} of ${p.total} files`
          : p.direction === 'up'
            ? `${p.total} files sent; committing`
            : `${p.total} files`),
    ]
    const w = BIRD.M[0].length
    const lines = bird.map((b, i) => {
      const pad = ' '.repeat(Math.max(0, w - visibleWidth(b)))
      return text[i] ? `${b}${pad}  ${text[i]}` : b
    })
    this.out.write(HIDE + lines.join('\n') + '\n')
    this.drawn = lines.length
  }
}

/** A Pecker for stdout, or null where the bird is not drawn (and output stays as it was). */
export function pecker(env: Env, out: Out = process.stdout): Pecker | null {
  if (!mascotOn(env, out) || (out.columns ?? 0) < 72) return null
  return new Pecker(out, depthOf())
}
