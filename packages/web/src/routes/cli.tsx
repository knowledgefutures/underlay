import { useState } from 'react'
import { Link, useLoaderData } from 'react-router'

import DocsLayout, { CodeBlock } from '~/components/DocsLayout'
import { HELP_EMAIL } from '~/lib/contact'

/**
 * underlay.org/cli: the Underlay CLI's documentation. The screenshots and the command
 * tables are made from the CLI itself at every build (scripts/cli-assets.ts), so they
 * match the CLI this deployment serves at /cli/install.sh.
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
  { key: 'collection', label: 'A collection' },
  { key: 'run', label: 'A finished run' },
  { key: 'push', label: 'Push' },
] as const

function Screens() {
  const [shot, setShot] = useState<(typeof SHOTS)[number]['key']>('collection')
  const current = SHOTS.find((s) => s.key === shot)!
  return (
    <figure className="mt-4 mb-6">
      <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Screens">
        {SHOTS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={s.key === shot}
            onClick={() => setShot(s.key)}
            className={`rounded-control px-2.5 py-1 text-xs font-medium transition-colors ${
              s.key === shot ? 'bg-ink text-parchment' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-[8px]">
        <img
          src={`/cli/screenshot-${current.key}.svg`}
          alt={`The terminal UI: ${current.label.toLowerCase()}`}
          width={1145}
          height={716}
          className="block h-auto w-full min-w-[640px]"
        />
      </div>
      <figcaption className="text-ink-muted mt-2 text-xs">
        The terminal UI, drawn by this version of the CLI when the site was built. The organizations
        in it are made up.
      </figcaption>
    </figure>
  )
}

function Commands() {
  if (!reference)
    return (
      <p>
        Run <code>underlay --help</code>, or <code>underlay &lt;command&gt; --help</code>.
      </p>
    )
  return (
    <>
      {reference.groups.map((g) => (
        <div key={g.title}>
          <h3>{g.title}</h3>
          <table className="border-collapse">
            <tbody>
              {g.commands.map((c) => (
                <tr key={c.name} id={`cmd-${c.name.replace(/\s+/g, '-')}`}>
                  <td style={{ width: '42%' }} className="font-mono">
                    {c.usage}
                  </td>
                  <td>
                    {c.description}
                    {c.options.map((o) => (
                      <div key={o.flags} className="text-ink-muted mt-0.5">
                        <span className="text-ink font-mono">{o.flags}</span>
                        {o.description ? ` ${o.description}` : ''}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  )
}

export default function CliPage() {
  const { origin, host } = useLoaderData() as { origin: string; host: string }
  const install = `curl -fsSL ${origin}/cli/install.sh | sh`
  return (
    <DocsLayout
      title="The Underlay CLI"
      eyebrow={`underlay${reference ? ` v${reference.version}` : ''} · preview`}
    >
      <p>
        <code>underlay</code> keeps collections on your machine. You add them from {host}, run
        scripts that write new versions of them, review what changed, and push. Every action is a
        command, so scripts, cron jobs and agents can use it too. Run plain <code>underlay</code> in
        a terminal to open its terminal UI.
      </p>
      <p>
        It is a preview and changes often. Push to a scratch collection while you try it, and write
        to <a href={`mailto:${HELP_EMAIL}`}>{HELP_EMAIL}</a> about anything that gets in your way.
      </p>

      <Screens />

      <h2>Install</h2>
      <p>
        You need <a href="https://nodejs.org">Node.js</a> 22.6 or later, on macOS or Linux.
      </p>
      <CodeBlock>{install}</CodeBlock>
      <p>
        The script downloads the CLI (one JavaScript file) to{' '}
        <code>~/.local/share/underlay-cli</code>, checks it against its SHA-256, and puts an{' '}
        <code>underlay</code> command in <code>~/.local/bin</code>. It tells you if that folder is
        not on your PATH. <a href="/cli/install.sh">Read the script</a> before you run it if you
        like. Run the same line again to update.
      </p>

      <h2>Sign in</h2>
      <p>
        Make an API key on <Link to="/settings/keys">your settings page</Link>, then run the command
        below and paste the key when it asks. On a Mac the key is kept in your keychain; elsewhere
        in a file only you can read, under <code>~/.config/underlay</code>.
      </p>
      <CodeBlock>{`underlay login ${host}
underlay remotes          # where you are signed in`}</CodeBlock>

      <h2>Workspaces</h2>
      <p>
        A workspace is a folder for your collections, scripts and views. It is plain files, so you
        can commit it to git. Records are not kept in it: they live in the store, which is{' '}
        <code>~/.local/share/underlay</code> unless you say otherwise.
      </p>
      <CodeBlock>{`underlay init ~/Underlay
cd ~/Underlay
underlay config set defaults.remote ${host}`}</CodeBlock>
      <table className="border-collapse">
        <tbody>
          <tr>
            <td>
              <code>underlay.toml</code>
            </td>
            <td>Remotes and defaults for this workspace, shared through git.</td>
          </tr>
          <tr>
            <td>
              <code>collections/</code>
            </td>
            <td>
              One folder for each collection, at <code>&lt;host&gt;/&lt;org&gt;/&lt;name&gt;/</code>
              : its <code>collection.toml</code>, a <code>README.md</code>, and a JSON Schema for
              each type in <code>schemas/</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>scripts/</code>
            </td>
            <td>
              Scripts that write collections, and saved imports in <code>scripts/imports/</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>inputs/</code>
            </td>
            <td>Files you add, and rows an import held back.</td>
          </tr>
          <tr>
            <td>
              <code>AGENTS.md</code>
            </td>
            <td>How the workspace works, for an agent working in it.</td>
          </tr>
        </tbody>
      </table>

      <h2>Collections</h2>
      <p>
        Every collection has an authority: the server that numbers its versions, usually {host}.
        <code>underlay ls</code> lists your organizations&apos; collections there;{' '}
        <code>underlay add</code> copies one to your machine with its schemas, history and records.
        With <code>--keep none</code> only its schemas and history are kept, and records are fetched
        when something reads them.
      </p>
      <CodeBlock>{`underlay ls
underlay add ${host}/your-org/a-collection
underlay new ${host}/your-org/scratch     # not there yet: your first push creates it
underlay status`}</CodeBlock>
      <p>
        In <code>underlay status</code> and the terminal UI, <code>■</code> means all of a
        collection&apos;s records are here, <code>◧</code> some, and <code>□</code> its metadata
        only. <code>↑2</code> is two versions not yet pushed, <code>↓1</code> one on the authority
        not yet pulled (in <code>status</code>, with <code>--fetch</code>), and <code>new</code> a
        collection not on its authority yet.
      </p>

      <h2>Scripts and runs</h2>
      <p>
        A script is a <code>.ts</code>, <code>.js</code>, <code>.mjs</code>, <code>.py</code> or{' '}
        <code>.sh</code> file in <code>scripts/</code>, or any executable. Its first lines name the
        collections it writes. When it runs, <code>UNDERLAY_OUT</code> is a folder to write to: one
        NDJSON file for each collection, one record a line.
      </p>
      <CodeBlock>{`// scripts/scratch.mjs
// underlay: writes ${host}/your-org/scratch
import { mkdirSync, writeFileSync } from 'node:fs'

const dir = process.env.UNDERLAY_OUT + '/${host}/your-org'
mkdirSync(dir, { recursive: true })

const records = [
  { id: 'a', type: 'Thing', data: { name: 'First' } },
  { id: 'b', type: 'Thing', data: { name: 'Second' } },
]
writeFileSync(dir + '/scratch.ndjson', records.map((r) => JSON.stringify(r)).join('\\n'))`}</CodeBlock>
      <CodeBlock>{`underlay run scratch
underlay runs             # every run, newest first`}</CodeBlock>
      <ul>
        <li>
          A script writes the whole collection. When it exits, the CLI compares what it wrote with
          the newest version and saves a new version with what changed. Records the script left out
          are removed.
        </li>
        <li>
          <code>// underlay: mode additions</code> makes a script&apos;s output additions and
          changes only. <code>// underlay: types Thesis</code> limits what it is the whole of to
          those types. These can also go in a <code>.toml</code> file beside the script.
        </li>
        <li>
          Every record is checked against its type&apos;s schema before the version is saved, as the
          server will check it. A script that exits non-zero saves nothing.
        </li>
        <li>A script that writes no collection is a check: it passes or fails.</li>
        <li>
          A run records the script&apos;s git commit, the files it read, its output, and the
          versions it saved. Two runs never write one collection at once.
        </li>
      </ul>

      <h2>Versions</h2>
      <p>A version stays on your machine until you push it. Until then you can change it.</p>
      <CodeBlock>{`underlay log scratch      # versions, and which are pushed
underlay diff scratch     # what a push would send
underlay undo scratch     # drop the newest version not yet pushed
underlay squash scratch   # merge versions not yet pushed into one
underlay reword scratch "A better message"`}</CodeBlock>
      <p>
        <code>underlay save</code> saves a version by hand: schema edits, or records from an NDJSON
        file. <code>underlay export</code> prints a version&apos;s records as NDJSON.
      </p>

      <h2>Imports</h2>
      <p>
        A spreadsheet, CSV, TSV, JSON, Parquet or SQLite file can be imported without a script.{' '}
        <code>underlay add-file</code> copies it into <code>inputs/</code>, shows its sheets and
        columns, and finds the collection whose ids it shares.
      </p>
      <CodeBlock>{`underlay add-file ~/Downloads/roster.xlsx
underlay import inputs/roster.xlsx --collection ${host}/your-org/staff \\
    --type Person --id staff_id`}</CodeBlock>
      <p>
        <code>underlay import</code> saves its options as <code>scripts/imports/roster.toml</code>{' '}
        and runs it, so next month&apos;s file takes one command. Columns that look personal, such
        as email, are left out unless you ask for them. Rows without an id are held in{' '}
        <code>inputs/</code> rather than guessed at. <code>underlay eject</code> turns an import
        into a script you can edit.
      </p>

      <h2>Pull and push</h2>
      <CodeBlock>{`underlay pull             # versions others pushed
underlay push             # yours, after a confirmation`}</CodeBlock>
      <ul>
        <li>
          Push lists every collection and version it will send, and checks that nothing newer is on
          the authority. A public collection, or one that would lose many records, needs{' '}
          <code>push</code> typed out.
        </li>
        <li>
          Versions arrive as you saved them: the same numbers, contents and ids. A version you cite
          from your machine is the version on {host}.
        </li>
        <li>
          If someone pushed first, your versions are rebuilt on top of theirs, renumbered, and shown
          to you again before you push.
        </li>
      </ul>

      <h2>The terminal UI</h2>
      <p>
        Plain <code>underlay</code> opens it. The sidebar lists your remotes, the collections on
        your machine, and your scripts. The main pane shows what is selected: a collection, a
        script&apos;s output as it runs, a finished run, or the push screen. The keys for each
        screen are along the bottom.
      </p>
      <table className="border-collapse">
        <tbody>
          {[
            ['↑ ↓', 'Move through the sidebar'],
            ['tab, ← →', 'Move to the main pane; switch a collection’s tabs'],
            ['r', 'Run the selected script, or one that writes the selected collection'],
            ['p', 'Push'],
            ['l', 'Pull the selected collection'],
            ['+', 'Add collections from a remote'],
            ['f', 'Add a file (or drop one on the terminal)'],
            ['h', 'Every run'],
            [',', 'Settings'],
            ['c, C', 'Copy a prompt for an agent; send it to the handoff command'],
            ['q', 'Quit'],
          ].map(([k, v]) => (
            <tr key={k}>
              <td>
                <code>{k}</code>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Agents</h2>
      <p>
        An agent works in a workspace with the same commands you use, and reads{' '}
        <code>AGENTS.md</code> to learn how. <code>underlay status --json</code> gives it the state
        of everything. Agents save versions; pushing is yours to do. To hand work to an agent from
        the terminal UI, <code>c</code> copies a prompt about what you are looking at, and{' '}
        <code>C</code> sends it to the command in <code>handoff.send</code>.
      </p>

      <h2>Settings</h2>
      <p>
        Your own settings are in <code>~/.config/underlay/config.toml</code>, and the
        workspace&apos;s in <code>underlay.toml</code>. <code>underlay config</code> lists both;{' '}
        <code>underlay config set</code> changes one. A store rule sends a collection&apos;s records
        somewhere else, or sets how much of it is kept:
      </p>
      <CodeBlock>{`underlay config rule add '${host}/your-org/*' --keep all
underlay config rule add '${host}/your-org/private' --path ~/Private/underlay`}</CodeBlock>

      <h2>Commands</h2>
      <p>
        Every command{reference ? ` in v${reference.version}` : ''}, as{' '}
        <code>underlay &lt;command&gt; --help</code> gives it.
      </p>
      <Commands />

      <h2>Update or remove</h2>
      <p>
        Run the install line again to update. To remove the CLI, delete{' '}
        <code>~/.local/bin/underlay</code> and <code>~/.local/share/underlay-cli</code>. Your
        workspace, and the records in <code>~/.local/share/underlay</code>, stay until you delete
        them.
      </p>
    </DocsLayout>
  )
}
