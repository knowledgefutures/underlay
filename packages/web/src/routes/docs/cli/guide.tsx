import { Link } from 'react-router'

import { cliEyebrow, CliScreens } from '~/components/CliDocs'
import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const KEYS: [string, string][] = [
  ['c', 'Collections on this machine: where you start, and where esc takes you back to'],
  ['n', 'A new collection: server, org, name, and access; the first push creates it on the server'],
  ['s', 'Servers'],
  ['r', 'Scripts and views'],
  ['↑ ↓', 'Move through the card that has the keys'],
  ['tab', 'Move between that card and the main pane'],
  ['← →', 'Switch a collection’s tabs'],
  ['R', 'Run the selected script, or one that writes the selected collection'],
  ['X, space, R', 'While a script runs: cancel, pause or resume, restart'],
  ['u', 'Undo the newest version not yet pushed, or a finished run’s versions'],
  ['l', 'Pull the selected collection'],
  [
    'k',
    'Keep everything, data without files, or metadata only; asks before deleting anything here',
  ],
  ['p, P', 'Push the selected collection; push every collection'],
  ['D', 'Remove the selected collection from this machine; it asks first'],
  ['+', 'Add collections from a remote'],
  ['f', 'Add a file (or drop one on the terminal)'],
  ['h', 'Every run'],
  [',', 'Settings'],
  ['?', 'Every key, with the ones for where you are lit'],
  ['a, A', 'Copy a prompt for an agent; send it to the handoff command'],
  ['o', 'Open the collection on its server'],
  ['x x', 'Quit (the first x says so)'],
]

export default function CliGuide() {
  return (
    <DocsLayout title="Guide" eyebrow={cliEyebrow}>
      <p>
        How the CLI works: your home, script folders, what is kept on your machine, scripts and
        imports, versions, pull and push, the terminal UI, and agents. For every command and option,
        see <Link to="/docs/cli/commands">Commands</Link>.
      </p>

      <h2>Home and script folders</h2>
      <p>
        Your collections live in your home, <code>~/Underlay</code> by default. It is yours and
        isn&apos;t shared: the collections you follow, their schemas, the files you add, and your
        own scripts. <code>underlay init</code> makes it.
      </p>

      <table className="border-collapse">
        <tbody>
          <tr>
            <td>
              <code>collections/</code>
            </td>
            <td>
              A folder for each collection at <code>&lt;server&gt;/&lt;org&gt;/&lt;name&gt;/</code>,
              named by its authority: <code>collection.toml</code> (its id, authority, and what is
              kept), <code>README.md</code>, and a JSON Schema for each type in{' '}
              <code>schemas/</code>. Schemas you edit here go up with the next version.
            </td>
          </tr>
          <tr>
            <td>
              <code>scripts/</code>
            </td>
            <td>
              Your own scripts and views, and saved imports in <code>scripts/imports/</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>inputs/</code>
            </td>
            <td>Files you add, rows an import held back, and choices a view saves.</td>
          </tr>
          <tr>
            <td>
              <code>AGENTS.md</code>
            </td>
            <td>How your home works, for an agent working in it.</td>
          </tr>
          <tr>
            <td>
              <code>.underlay/</code>
            </td>
            <td>Run history and locks.</td>
          </tr>
        </tbody>
      </table>

      <p>
        Scripts you share live in script folders: a git repo of scripts with its own dependencies,
        such as one your team keeps. Add one, and its scripts appear beside yours, named after the
        folder (<code>team/monthly</code>). Running <code>underlay</code> inside a folder that has
        an <code>underlay.toml</code> picks it up too. A script folder has no collections or
        schemas: each person pulls those into their own home.
      </p>
      <CodeBlock>{`underlay sources add ~/code/team-scripts --name team
underlay sources              # home, and each script folder`}</CodeBlock>
      <p>
        A script folder&apos;s <code>underlay.toml</code> is optional and says only what belongs to
        its code:
      </p>
      <CodeBlock>{`scripts = ["sources"]          # where to look (default: the whole folder)
authority = "underlay.org"     # for collections its scripts name as org/name

[runners]                      # how to run a file, when the defaults don't fit
".ts" = "pnpm exec tsx"

[env]                          # secrets its scripts need: names only
need = ["ORCID_TOKEN"]`}</CodeBlock>
      <p>
        Each person keeps a secret&apos;s value with <code>underlay secret set ORCID_TOKEN</code>{' '}
        (in the keychain on a Mac) or in their environment. A run that lacks one stops before it
        starts.
      </p>

      <h2>What is kept on your machine</h2>
      <p>
        Records are not kept in your home. They live in the store,{' '}
        <code>~/.local/share/underlay</code> by default, with versions not yet pushed and run logs.
        A record file is kept once however many collections name it.
      </p>
      <p>
        <code>underlay add</code> keeps everything: a collection&apos;s records and its files (the
        PDFs, images and other assets its records point to, at <code>assets/</code> in the store).
        With <code>--keep records</code>, its records but not its files; with{' '}
        <code>--keep none</code>, only its schemas and history, and records are fetched from its
        authority when something reads them; <code>--keep some --types A,B</code> keeps some types.
        <code>underlay keep</code> (with <code>--records</code> or <code>--types</code>) and{' '}
        <code>underlay forget</code> change this later, and <code>k</code> in the terminal UI asks
        before it deletes anything here. <code>underlay remove</code> takes a collection off your
        machine altogether; it stays on its server.
      </p>
      <p>
        <code>underlay asset add &lt;collection&gt; &lt;file&gt;</code> adds a file: a version that
        names it, and its bytes are sent before that version on <code>underlay push</code>.{' '}
        <code>underlay asset &lt;collection&gt;</code> lists a collection&apos;s files and which are
        here.
      </p>
      <p>A collection with everything here has no mark.</p>
      <table className="border-collapse">
        <tbody>
          {[
            ['◐', 'Some of it is here: its records but not its files, or some types'],
            ['○', 'Its schemas and history only'],
            ['↑2', 'Two versions here that are not pushed'],
            [
              '↓1',
              'One version on the authority not yet pulled (in underlay status, with --fetch)',
            ],
            ['new', 'Not on its authority yet: the first push creates it'],
            ['▶', 'A script is writing it now'],
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

      <h2>Settings</h2>
      <p>
        Your settings are in <code>~/.config/underlay/config.toml</code>: where your home is, the
        store, your remotes, your script folders, where keys are kept. <code>underlay config</code>{' '}
        lists every setting and whether it is set. <code>UNDERLAY_HOME</code> points at another home
        for one command.
      </p>
      <CodeBlock>{`underlay config
underlay config set defaults.remote underlay.org
underlay config set store.path /Volumes/Data/underlay`}</CodeBlock>
      <p>
        The woodpecker from the Underlay logo is drawn in the terminal on the keys screen, beside a
        long push or pull, and after <code>underlay init</code>. It is never drawn when output goes
        to a file or another program, or when <code>NO_COLOR</code> is set.{' '}
        <code>underlay config set mascot off</code> turns it off.
      </p>
      <p>
        A store rule sends some collections&apos; records somewhere else, or sets how much of them
        is kept. The most specific match wins.
      </p>
      <CodeBlock>{`underlay config rule add 'underlay.org/your-org/*' --keep all
underlay config rule add 'underlay.org/your-org/private' --path ~/Private/underlay`}</CodeBlock>

      <h2>Scripts</h2>
      <p>
        A script is a <code>.ts</code>, <code>.js</code>, <code>.mjs</code>, <code>.py</code> or{' '}
        <code>.sh</code> file, or any executable, in your home&apos;s <code>scripts/</code> or a
        script folder. Its first lines say what it does; files without them, such as helpers,
        aren&apos;t scripts. It runs in its own folder, so its dependencies resolve. When it runs,{' '}
        <code>UNDERLAY_OUT</code> is a folder to write to: one NDJSON file for each collection, at{' '}
        <code>&lt;server&gt;/&lt;org&gt;/&lt;name&gt;.ndjson</code>, one record a line.{' '}
        <code>UNDERLAY_HOME</code> is your home, and <code>underlay schema &lt;collection&gt;</code>{' '}
        prints a collection&apos;s schemas for a script that needs them.
      </p>
      <CodeBlock>{`// ~/Underlay/scripts/scratch.mjs
// underlay: writes underlay.org/your-org/scratch
import { mkdirSync, writeFileSync } from 'node:fs'

const dir = process.env.UNDERLAY_OUT + '/underlay.org/your-org'
mkdirSync(dir, { recursive: true })

const records = [
  { id: 'a', type: 'Thing', data: { name: 'First' } },
  { id: 'b', type: 'Thing', data: { name: 'Second' } },
]
writeFileSync(dir + '/scratch.ndjson', records.map((r) => JSON.stringify(r)).join('\\n'))`}</CodeBlock>

      <h2>What a script declares</h2>
      <table className="border-collapse">
        <tbody>
          <tr>
            <td>
              <code>writes</code>
            </td>
            <td>
              The collections it writes, as <code>server/org/name</code> or <code>org/name</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>check</code>
            </td>
            <td>It writes nothing: it passes or fails.</td>
          </tr>
          <tr>
            <td>
              <code>view</code>, <code>serves</code>
            </td>
            <td>
              A view: an <code>.html</code> page, or a script that serves a page (see Views).
            </td>
          </tr>
          <tr>
            <td>
              <code>reads</code>
            </td>
            <td>Collections it reads, for the record.</td>
          </tr>
          <tr>
            <td>
              <code>takes</code>
            </td>
            <td>
              The files it takes, as a pattern such as <code>*.xlsx</code>. Files you add offer the
              scripts that take them.
            </td>
          </tr>
          <tr>
            <td>
              <code>mode</code>
            </td>
            <td>
              <code>set</code> (the default) or <code>additions</code>; see below.
            </td>
          </tr>
          <tr>
            <td>
              <code>types</code>
            </td>
            <td>
              With <code>set</code>, the types the script writes the whole of.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Each goes on a line of its own, as <code>// underlay: mode additions</code> (or with{' '}
        <code>#</code> in Python and shell, and <code>&lt;!-- --&gt;</code> in HTML), or several on
        one line with commas: <code>// underlay: check, reads org/units</code>. They can also go in
        a <code>.toml</code> file beside the script with the same name, which may set{' '}
        <code>run</code>, the command that runs it.
      </p>

      <h2>Runs</h2>
      <CodeBlock>{`underlay run scratch [args]
underlay runs                 # every run, newest first
underlay runs <id> --follow   # one run's output`}</CodeBlock>
      <ul>
        <li>
          A script writes the whole collection. When it exits, the CLI compares what it wrote with
          the newest version and saves a new version with what changed. Records it left out are
          removed. With <code>mode additions</code>, its output is additions and changes only; a
          record it writes as <code>{'{"id", "type", "removed": true}'}</code> is removed.
        </li>
        <li>
          Every record is checked against its type&apos;s schema before the version is saved, as the
          server will check it. A script that exits non-zero saves nothing.
        </li>
        <li>
          A run records the script&apos;s git commit, the files it read, its output, and the
          versions it saved. Two runs never write one collection at once.
        </li>
        <li>
          A run started from the terminal UI keeps running when you close it.{' '}
          <code>underlay pause</code>, <code>resume</code> and <code>cancel</code> take a run&apos;s
          id.
        </li>
      </ul>

      <h2>Imports</h2>
      <p>
        A spreadsheet, CSV, TSV, JSON, Parquet or SQLite file can be imported without a script.{' '}
        <code>underlay add-file</code> copies it into your home&apos;s <code>inputs/</code>, shows
        its sheets and columns, and finds the collection whose ids it shares.
      </p>
      <CodeBlock>{`underlay add-file ~/Downloads/roster.xlsx
underlay import inputs/roster.xlsx --collection underlay.org/your-org/staff \\
    --type Person --id staff_id`}</CodeBlock>
      <ul>
        <li>
          <code>underlay import</code> saves its options as <code>scripts/imports/roster.toml</code>{' '}
          in your home and runs it. Next month,{' '}
          <code>underlay run imports/roster inputs/roster-2026-12.xlsx</code>. Move the file into a
          script folder to share it.
        </li>
        <li>
          Columns are matched to the schema&apos;s fields by name. Columns that look personal, such
          as email or phone, are left out unless you pass <code>--personal</code>;{' '}
          <code>--column name=field</code> maps one by hand.
        </li>
        <li>
          Rows without an id are held in <code>inputs/&lt;import&gt;-held.ndjson</code> rather than
          guessed at, and nothing is removed while rows are held. Choices for them go in{' '}
          <code>inputs/&lt;import&gt;-decisions.json</code>, which the next run reads.
        </li>
        <li>
          <code>underlay eject</code> turns an import into a script you can edit, with its options
          written in. <code>underlay read</code> prints a file&apos;s rows as NDJSON.
        </li>
      </ul>
      <p>
        In the terminal UI, a file whose ids match nothing here offers{' '}
        <strong>Make a new collection from this file</strong> (<code>n</code>), with its name and
        type taken from the file. When the type has no schema yet, the file screen drafts one from
        the columns: a field for each column but the id, its type guessed from every value, and
        required where no row leaves it blank. Columns that look personal start left out.{' '}
        <code>space</code> keeps or leaves out a column, <code>←→</code> changes its type,{' '}
        <code>e</code> opens the draft as JSON, <code>A</code> hands it to an agent to shape, and{' '}
        <code>enter</code> saves it to the collection&apos;s <code>schemas/</code> and imports.
      </p>

      <h2>Views</h2>
      <p>
        A view is a page for looking at results, kept beside the scripts it goes with. An{' '}
        <code>.html</code> file with <code>&lt;!-- underlay: view --&gt;</code> opens in your
        browser as it is. A script that declares <code>serves</code> is given a free port as{' '}
        <code>PORT</code>; the CLI waits until it listens, opens it, and stops it when you are done.
        A view never writes records: it saves choices to a file in <code>inputs/</code> that a
        script reads on its next run.
      </p>
      <CodeBlock>{`underlay view held-rows      # opens it; Ctrl-C stops one that serves`}</CodeBlock>

      <h2>Versions</h2>
      <p>
        A version is saved on your machine by a run, an import, or <code>underlay save</code>. It is
        a real version of the collection, with its number and id, but nobody else sees it until you
        push it.
      </p>

      <CodeBlock>{`underlay log scratch      # versions, and which are pushed
underlay diff scratch     # what a push would send
underlay undo scratch     # drop the newest version not yet pushed
underlay squash scratch   # merge versions not yet pushed into one
underlay reword scratch "A better message"`}</CodeBlock>
      <p>
        Squash is useful before a push: the states in between are never uploaded.{' '}
        <code>underlay save</code> saves a version by hand, from schema edits or an NDJSON file, and{' '}
        <code>underlay export</code> prints a version&apos;s records as NDJSON.
      </p>

      <h2>Pull</h2>
      <CodeBlock>{`underlay pull             # every collection, or name some`}</CodeBlock>
      <p>
        Pull follows each collection&apos;s authority and brings in versions others pushed, with the
        files of what you keep. Your versions not yet pushed are rebuilt on top of them and
        renumbered.
      </p>

      <h2>Push</h2>
      <CodeBlock>{`underlay push             # every collection, or name some`}</CodeBlock>
      <ul>
        <li>
          Push lists each collection and version it will send, and checks that nothing newer is on
          the authority. A public collection, or one that would lose many records, needs{' '}
          <code>push</code> typed out. Otherwise <code>y</code> is enough, and <code>--yes</code>{' '}
          answers it.
        </li>
        <li>
          Versions arrive as you saved them: the same numbers, contents and ids, so a version you
          cite from your machine is the version on the server. The server signs a receipt for each
          one (<Link to="/docs/protocol/push-and-pull">Push and pull</Link>).
        </li>
        <li>
          If someone pushed first, the server refuses and your versions are rebuilt on top of
          theirs, renumbered, and shown to you again before you push.
        </li>
        <li>
          A collection made with <code>underlay new</code> is created on its authority by its first
          push.
        </li>
      </ul>
      <h2>Terminal UI</h2>
      <p>
        Plain <code>underlay</code> in a terminal opens it on your home and script folders. It calls
        the same code as the commands and watches those folders, so what a command, another
        terminal, or an agent does shows up as it happens.
      </p>
      <CliScreens />

      <ul>
        <li>
          <strong>Servers</strong> (<code>s</code>): the servers you can use, whether you are signed
          in, and how many of your organizations&apos; collections there are on your machine.
        </li>
        <li>
          <strong>Collections on this machine</strong> (<code>c</code>): your collections, by
          authority and organization, with what is kept and how each stands against its authority.
          The UI opens here, and <code>esc</code> comes back here.
        </li>
        <li>
          <strong>Scripts and views</strong> (<code>r</code>): each script with its last result, and
          your views, under the name of the folder they come from. <code>v</code> opens a view.
        </li>
        <li>
          The main pane shows what is selected: a collection (Overview, Records, Schemas, Files,
          Versions, where choosing a version shows what it changed), a script&apos;s output as it
          runs, a finished run, the push screen, a remote&apos;s list of collections to add, or a
          file you added.
        </li>
        <li>
          <strong>Settings</strong> (<code>,</code>) and <strong>Keys</strong> (<code>?</code>) take
          the whole window. Settings lists every setting by section, with what the selected one does
          beside it: <code>enter</code> edits it, or steps through its choices; <code>d</code> puts
          it back to its default; <code>o</code> opens <code>config.toml</code>.
        </li>
      </ul>

      <h2>Keys</h2>
      <p>
        The keys for the screen you are on are along the bottom, and <code>?</code> shows them all.
      </p>
      <table className="border-collapse">
        <tbody>
          {KEYS.map(([k, v]) => (
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
        An agent works in your home or a script folder with the same commands you use, and reads{' '}
        <code>AGENTS.md</code> to learn how. <code>underlay status --json</code> gives it the state
        of everything. Agents save versions; pushing is yours to do.
      </p>
      <p>
        To hand work to an agent from the terminal UI, <code>a</code> copies a prompt about what you
        are looking at, and <code>A</code> sends it to the command set in <code>handoff.send</code>,
        which takes the prompt on its standard input.
      </p>
      <CodeBlock>{`underlay config set handoff.send 'your-agent-command -'`}</CodeBlock>
    </DocsLayout>
  )
}
