import { useState } from 'react'
import { Link, useLoaderData } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { HELP_EMAIL } from '~/lib/contact'

/**
 * underlay.org/cli: the Underlay CLI. The screenshots and the command reference are made
 * from the CLI itself at every build (scripts/cli-assets.ts), so they match the CLI this
 * deployment serves at /cli/install.sh.
 */

interface Reference {
  version: string
  groups: {
    title: string
    commands: {
      name: string
      usage: string
      description: string
      options: { flags: string; description: string }[]
    }[]
  }[]
}

// Absent until the first build makes it (a typecheck runs before any build).
const generated = import.meta.glob<Reference>('../generated/cli-reference.json', {
  eager: true,
  import: 'default',
})
const reference: Reference | null = Object.values(generated)[0] ?? null

const SHOTS = [
  {
    key: 'collection',
    label: 'A collection',
    caption:
      'A collection on your machine: what is kept here, the version a run saved and you have not pushed, and the scripts that write it.',
  },
  {
    key: 'run',
    label: 'A finished run',
    caption:
      'A script ran and exited. Each collection it changed has a new version here, with what was added, changed and removed. Nothing has left the machine.',
  },
  {
    key: 'push',
    label: 'Push',
    caption:
      'Push lists every version it will copy and checks the authority first. A public collection needs push typed out.',
  },
] as const

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        })
      }}
      className="text-parchment-dark/80 hover:text-parchment border-parchment/20 hover:border-parchment/40 rounded-control shrink-0 border px-2.5 py-1 font-sans text-xs transition-colors"
      aria-label="Copy the install command"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function Code({ children, label }: { children: string; label?: string }) {
  return (
    <div className="bg-ink text-parchment rounded-surface min-w-0 overflow-hidden">
      {label && (
        <p className="text-parchment-dark/60 m-0 px-4 pt-3 text-[11px] tracking-wider uppercase">
          {label}
        </p>
      )}
      <pre className="m-0 overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed [font-variant-ligatures:none]">
        {children.split('\n').map((line, i) => (
          <div key={i}>
            {line.startsWith('#') ? (
              <span className="text-parchment-dark/55">{line}</span>
            ) : line.startsWith('$ ') ? (
              <>
                <span className="text-parchment-dark/45 select-none">$ </span>
                {line.slice(2)}
              </>
            ) : (
              line || ' '
            )}
          </div>
        ))}
      </pre>
    </div>
  )
}

function SectionHead(props: { id: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-8 max-w-2xl">
      <h2
        id={props.id}
        className="scroll-mt-20 font-sans text-2xl leading-snug font-semibold tracking-tight"
      >
        {props.title}
      </h2>
      {props.children && (
        <p className="text-ink-light mt-2 text-[15px] leading-relaxed">{props.children}</p>
      )}
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
      <span className="border-rule text-ink-muted bg-parchment flex h-7 w-7 items-center justify-center rounded-full border font-mono text-xs">
        {n}
      </span>
      <div className="min-w-0">
        <h3 className="m-0 pt-0.5 text-base font-semibold">{title}</h3>
        <div className="text-ink-light mt-2 grid gap-3 text-[15px] leading-relaxed">{children}</div>
      </div>
    </div>
  )
}

const STEPS = (host: string) => [
  [
    'Add',
    `Add collections from your organizations on ${host}, with all their records or only their schemas and history. Or start a new one.`,
  ],
  [
    'Run',
    'A script writes the records a collection should hold. The CLI compares them with the newest version and saves a new one with what changed.',
  ],
  [
    'Review',
    'See what each version not yet pushed added, changed and removed. Undo one, squash several into one, or change a message.',
  ],
  [
    'Push',
    'Push copies your versions to the authority exactly as they are, with the same numbers and ids. It asks first, and it is the only step that publishes.',
  ],
]

export default function CliPage() {
  const { origin, host } = useLoaderData() as { origin: string; host: string }
  const [shot, setShot] = useState<(typeof SHOTS)[number]['key']>('collection')
  const install = `curl -fsSL ${origin}/cli/install.sh | sh`
  const current = SHOTS.find((s) => s.key === shot)!
  let bands = 0
  const band = () => `border-rule border-t ${bands++ % 2 ? 'bg-parchment-dark/50' : 'bg-parchment'}`

  return (
    <BaseLayout tinted flushFooter>
      {/* Hero, and the screens */}
      <section className="bg-parchment-dark">
        <div className="mx-auto max-w-5xl px-4 pt-14 pb-10">
          <p className="text-ink-muted m-0 font-mono text-xs">
            underlay{reference ? ` v${reference.version}` : ''} · preview
          </p>
          <h1 className="mt-3 font-sans text-3xl leading-tight font-semibold tracking-tight md:text-[2.625rem] md:leading-[1.12]">
            The Underlay CLI
          </h1>
          <p className="text-ink-light mt-4 max-w-[62ch] text-base leading-relaxed">
            Keep collections on your machine, run the scripts that update them, review every version
            before it leaves, and push when it is ready. Every action is a command, so cron jobs and
            agents can use it too. Plain <code>underlay</code> opens a terminal UI.
          </p>
          <div className="bg-ink text-parchment rounded-surface mt-7 flex max-w-2xl items-center gap-3 py-2.5 pr-2.5 pl-4">
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap">
              <span className="text-parchment-dark/45 select-none">$ </span>
              {install}
            </code>
            <CopyButton text={install} />
          </div>
          <p className="text-ink-muted mt-3 text-xs leading-relaxed">
            Needs{' '}
            <a href="https://nodejs.org" className="underline">
              Node.js
            </a>{' '}
            22.6 or later, on macOS or Linux. One file, checked against its SHA-256.{' '}
            <a href="/cli/install.sh" className="underline">
              Read the script
            </a>{' '}
            ·{' '}
            <a href="#start" className="underline">
              Get started
            </a>{' '}
            ·{' '}
            <a href="#commands" className="underline">
              Commands
            </a>
          </p>
        </div>
        <div className="mx-auto max-w-5xl px-4 pb-16">
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Screens">
            {SHOTS.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={s.key === shot}
                onClick={() => setShot(s.key)}
                className={`rounded-control px-3 py-1.5 text-sm font-medium transition-colors ${
                  s.key === shot
                    ? 'bg-ink text-parchment'
                    : 'text-ink-light hover:bg-parchment/70 hover:text-ink'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <figure className="m-0">
            <div className="overflow-x-auto rounded-[10px] shadow-[0_0_0_1px_rgba(26,26,24,0.5),0_24px_60px_rgba(26,26,24,0.28)]">
              <img
                src={`/cli/screenshot-${current.key}.svg`}
                alt={`The Underlay CLI's terminal UI: ${current.label.toLowerCase()}`}
                width={1145}
                height={716}
                className="block h-auto w-full min-w-[720px]"
              />
            </div>
            <figcaption className="text-ink-muted mt-3 max-w-[72ch] text-sm leading-relaxed">
              {current.caption} The organizations are made up. The CLI draws these screens itself
              each time the site is built, so they show the version you install here.
            </figcaption>
          </figure>
        </div>
      </section>

      {/* How it works */}
      <section className={band()}>
        <div className="mx-auto max-w-5xl px-4 py-16">
          <SectionHead id="how" title="How it works">
            Each collection has an authority, the server that numbers its versions: usually {host}.
            The CLI keeps a copy of the collection on your machine and makes new versions there.
          </SectionHead>
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS(host).map(([title, text], i) => (
              <div key={title}>
                <p className="text-accent m-0 font-mono text-xs">0{i + 1}</p>
                <h3 className="mt-1.5 mb-0 text-base font-semibold">{title}</h3>
                <p className="text-ink-light mt-1.5 text-sm leading-relaxed">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Get started */}
      <section className={band()}>
        <div className="mx-auto max-w-5xl px-4 py-16">
          <SectionHead id="start" title="Get started">
            From nothing to a pushed version in a few minutes. Use a scratch collection while you
            try it.
          </SectionHead>
          <div className="grid max-w-3xl gap-9">
            <Step n={1} title="Install">
              <Code>{`$ ${install}`}</Code>
              <p className="m-0">
                The CLI goes in <code>~/.local/share/underlay-cli</code> and the{' '}
                <code>underlay</code> command in <code>~/.local/bin</code>. The script tells you if
                that folder is not on your PATH.
              </p>
            </Step>
            <Step n={2} title="Sign in">
              <p className="m-0">
                Make an API key on{' '}
                <Link to="/settings/keys" className="text-link hover:underline">
                  your settings page
                </Link>
                , then paste it when asked. On a Mac it is kept in your keychain.
              </p>
              <Code>{`$ underlay login ${host}`}</Code>
            </Step>
            <Step n={3} title="Make a workspace">
              <p className="m-0">
                A folder for your collections, scripts and views, which you can commit to git.
                Records are kept outside it, in <code>~/.local/share/underlay</code>.
              </p>
              <Code>{`$ underlay init ~/Underlay
$ cd ~/Underlay
$ underlay config set defaults.remote ${host}`}</Code>
            </Step>
            <Step n={4} title="Add a collection, or start one">
              <Code>{`$ underlay ls
$ underlay add ${host}/your-org/a-collection
# or one that isn't there yet; your first push creates it
$ underlay new ${host}/your-org/scratch`}</Code>
            </Step>
            <Step n={5} title="Run a script">
              <p className="m-0">
                Put a JSON Schema for each type in the collection&apos;s <code>schemas/</code>{' '}
                folder and a script in <code>scripts/</code> (see{' '}
                <a href="#scripts" className="text-link hover:underline">
                  Scripts
                </a>
                ). Run it, then look at what it saved.
              </p>
              <Code>{`$ underlay run scratch
$ underlay diff scratch`}</Code>
            </Step>
            <Step n={6} title="Push">
              <Code>{`$ underlay push`}</Code>
              <p className="m-0">
                Or run plain <code>underlay</code> and do all of this in the terminal UI.
              </p>
            </Step>
          </div>
        </div>
      </section>

      {/* Scripts */}
      <section className={band()}>
        <div className="mx-auto max-w-5xl px-4 py-16">
          <SectionHead id="scripts" title="Scripts">
            A script can be a <code>.ts</code>, <code>.js</code>, <code>.py</code> or{' '}
            <code>.sh</code> file, or any program. It names the collections it writes in its first
            lines and writes one record a line.
          </SectionHead>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <Code label="scripts/scratch.mjs">{`// underlay: writes ${host}/your-org/scratch
import { mkdirSync, writeFileSync } from 'node:fs'

const dir = process.env.UNDERLAY_OUT + '/${host}/your-org'
mkdirSync(dir, { recursive: true })

const records = [
  { id: 'a', type: 'Thing', data: { name: 'First' } },
  { id: 'b', type: 'Thing', data: { name: 'Second' } },
]
const lines = records.map((r) => JSON.stringify(r))
writeFileSync(dir + '/scratch.ndjson', lines.join('\\n'))`}</Code>
            <div className="text-ink-light grid content-start gap-4 text-[15px] leading-relaxed">
              <p className="m-0">
                <strong className="text-ink">The whole collection, each time.</strong> The CLI
                compares what the script wrote with the newest version. New and changed records are
                saved, and records it left out are removed. A script that only adds and updates says{' '}
                <code className="whitespace-nowrap">// underlay: mode additions</code>.
              </p>
              <p className="m-0">
                <strong className="text-ink">Checked before it is saved.</strong> Every record is
                validated against its type&apos;s schema, as the server will validate it.
              </p>
              <p className="m-0">
                <strong className="text-ink">A file, without a script.</strong>{' '}
                <code className="whitespace-nowrap">underlay add-file roster.xlsx</code> reads a
                spreadsheet, CSV, JSON, Parquet or SQLite file and finds the collection whose ids it
                shares. <code>underlay import</code> keeps the options, so next month&apos;s file
                takes one command.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Push, and agents */}
      <section className={band()}>
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-12 px-4 py-16 md:grid-cols-2">
          <div>
            <SectionHead id="push" title="Pushing is the careful step" />
            <ul className="text-ink-light m-0 grid list-none gap-3 p-0 text-[15px] leading-relaxed">
              <li>
                Versions arrive exactly as you saved them, with the same numbers, contents and ids.
                A version cited from your machine is the version on {host}.
              </li>
              <li>
                Push shows every collection and version first. A public collection, or one that
                loses many records, needs <code>push</code> typed out.
              </li>
              <li>
                If someone pushed first, your versions are rebuilt on top of theirs and shown to you
                again before anything is sent.
              </li>
            </ul>
          </div>
          <div>
            <SectionHead id="agents" title="With an agent" />
            <ul className="text-ink-light m-0 grid list-none gap-3 p-0 text-[15px] leading-relaxed">
              <li>
                <code>underlay init</code> writes an <code>AGENTS.md</code> that tells an agent how
                the workspace is laid out and how scripts work.
              </li>
              <li>
                Agents use the same commands: <code>underlay status --json</code>, <code>run</code>,{' '}
                <code>diff</code>. Saving versions is theirs to do; pushing is yours.
              </li>
              <li>
                In the terminal UI, <code>c</code> copies a prompt about what you are looking at,
                and <code>C</code> sends it to a command you choose.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Commands */}
      <section className={band()}>
        <div className="mx-auto max-w-5xl px-4 py-16">
          <SectionHead id="commands" title="Commands">
            Every command, read from the CLI itself
            {reference ? ` (v${reference.version})` : ''}.{' '}
            <code>underlay &lt;command&gt; --help</code> says the same in your terminal.
          </SectionHead>
          {reference ? (
            <div className="grid gap-10">
              {reference.groups.map((g) => (
                <div key={g.title}>
                  <h3 className="text-ink-muted mt-0 mb-3 text-[11px] font-semibold tracking-wider uppercase">
                    {g.title}
                  </h3>
                  <div className="border-rule rounded-surface bg-parchment overflow-hidden border">
                    {g.commands.map((c) => (
                      <div
                        key={c.name}
                        id={`cmd-${c.name.replace(/\s+/g, '-')}`}
                        className="border-rule grid grid-cols-1 gap-1 border-b px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:gap-6"
                      >
                        <code className="text-ink font-mono text-[13px] break-words">
                          {c.usage}
                        </code>
                        <div className="min-w-0 text-sm">
                          <p className="text-ink-light m-0 leading-relaxed">{c.description}</p>
                          {c.options.length > 0 && (
                            <dl className="m-0 mt-2 grid gap-1 text-xs">
                              {c.options.map((o) => (
                                <div
                                  key={o.flags}
                                  className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-3"
                                >
                                  <dt className="text-ink font-mono whitespace-nowrap">
                                    {o.flags}
                                  </dt>
                                  <dd className="text-ink-muted m-0">{o.description}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-ink-muted">
              Run <code>underlay --help</code> for every command.
            </p>
          )}
        </div>
      </section>

      {/* Update or remove */}
      <section className="bg-ink text-parchment">
        <div className="mx-auto max-w-5xl px-4 py-14">
          <h2 className="m-0 font-sans text-xl font-semibold tracking-tight">Update or remove</h2>
          <p className="text-parchment-dark mt-3 max-w-[66ch] text-[15px] leading-relaxed">
            Run the install line again to update. To remove the CLI, delete{' '}
            <code>~/.local/bin/underlay</code> and <code>~/.local/share/underlay-cli</code>. Your
            workspace, and the records in <code>~/.local/share/underlay</code>, stay until you
            delete them. The CLI is a preview and changes often. Write to{' '}
            <a href={`mailto:${HELP_EMAIL}`} className="underline">
              {HELP_EMAIL}
            </a>{' '}
            about anything that gets in your way.
          </p>
        </div>
      </section>
    </BaseLayout>
  )
}
