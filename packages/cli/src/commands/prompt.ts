/** Asking on the terminal: a line, a hidden line (an API key), a yes. */
import { createInterface } from 'node:readline/promises'

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/** A line typed without echo, for a key. Falls back to a plain line when stdin is not a terminal. */
export async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question)
  process.stdout.write(question)
  return new Promise((done) => {
    let typed = ''
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    const onData = (b: Buffer) => {
      for (const ch of b.toString()) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          done(typed.trim())
          return
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f') typed = typed.slice(0, -1)
        else typed += ch
      }
    }
    stdin.on('data', onData)
  })
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `))
}

/** The loud confirmation: the word itself must be typed. */
export async function confirmTyped(question: string, word: string): Promise<boolean> {
  return (await ask(`${question} Type ${word} to go ahead: `)) === word
}
