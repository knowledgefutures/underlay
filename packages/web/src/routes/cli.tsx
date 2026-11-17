import { Link, useLoaderData } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

const pre = 'bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs'

export default function CliPage() {
  const { origin, host } = useLoaderData() as { origin: string; host: string }
  const install = `curl -fsSL ${origin}/cli/install.sh | sh`
  return (
    <DocsLayout title="The Underlay CLI">
      <p>
        <code>underlay</code> keeps collections on your machine. You add them from {host}, run
        scripts that write new versions of them, look over what changed, and push. Every action is a
        command, so scripts, cron jobs and agents can use it too. Run plain <code>underlay</code> in
        a terminal to open its terminal UI.
      </p>
      <p className="text-ink-muted text-sm">
        It is new and still changing. Push to a scratch collection while you try it.
      </p>

      <h2>Install</h2>
      <p>
        You need{' '}
        <a href="https://nodejs.org" className="text-link hover:underline">
          Node.js
        </a>{' '}
        22.6 or later. Then run:
      </p>
      <pre className={pre}>{install}</pre>
      <p>
        This downloads one JavaScript file to <code>~/.local/share/underlay-cli</code>, checks it
        against its SHA-256, and puts an <code>underlay</code> command in <code>~/.local/bin</code>.
        It tells you if that folder isn't on your PATH. You can{' '}
        <a href="/cli/install.sh" className="text-link hover:underline">
          read the script
        </a>{' '}
        before you run it. Run the same line again to update.
      </p>

      <h2>Sign in</h2>
      <p>
        Make an API key on{' '}
        <Link to="/settings/keys" className="text-link hover:underline">
          your settings page
        </Link>
        , then:
      </p>
      <pre className={pre}>{`underlay login ${host}`}</pre>
      <p>
        Paste the key when asked. On a Mac it goes in your keychain; elsewhere in a file only you
        can read, under <code>~/.config/underlay</code>.
      </p>

      <h2>Make a workspace</h2>
      <p>
        A workspace is a folder for your collections, scripts and views. You can commit it to git.
        Records don't go in it: they live in <code>~/.local/share/underlay</code>.
      </p>
      <pre className={pre}>{`underlay init ~/Underlay
cd ~/Underlay
underlay config set defaults.remote ${host}`}</pre>
      <p>
        <code>init</code> also writes an <code>AGENTS.md</code>, so an agent working in the folder
        knows how it is laid out.
      </p>

      <h2>Add a collection</h2>
      <pre className={pre}>{`underlay ls                         # your orgs' collections
underlay add ${host}/your-org/a-collection
underlay new ${host}/your-org/scratch   # one that isn't there yet; your first push creates it`}</pre>

      <h2>Run a script</h2>
      <p>
        A script writes NDJSON (<code>{'{"id", "type", "data"}'}</code>, one record a line) to{' '}
        <code>$UNDERLAY_OUT/&lt;host&gt;/&lt;org&gt;/&lt;name&gt;.ndjson</code>, and names the
        collections it writes in its first lines:
      </p>
      <pre className={pre}>{`// underlay: writes ${host}/your-org/scratch
import { mkdirSync, writeFileSync } from 'node:fs'

const dir = process.env.UNDERLAY_OUT + '/${host}/your-org'
mkdirSync(dir, { recursive: true })
writeFileSync(dir + '/scratch.ndjson', JSON.stringify({ id: 'a', type: 'Thing', data: { name: 'A' } }) + '\\n')`}</pre>
      <p>
        Save it as <code>scripts/scratch.mjs</code> (a <code>.ts</code>, <code>.py</code> or{' '}
        <code>.sh</code> file works too), and put a JSON Schema for each type in the collection's{' '}
        <code>schemas/</code> folder, as <code>schemas/Thing.json</code>. Then:
      </p>
      <pre className={pre}>{`underlay run scratch
underlay diff scratch
underlay log scratch`}</pre>
      <p>
        Each run that changes a collection saves a new version on your machine. A script writes the
        whole collection, and records it leaves out are removed. Until you push, you can{' '}
        <code>undo</code>, <code>squash</code> or <code>reword</code> versions.
      </p>
      <p>
        For a spreadsheet, a CSV, JSON, Parquet or a SQLite file, you don't need a script.{' '}
        <code>underlay add-file roster.xlsx</code> shows which collection the file matches, and{' '}
        <code>underlay import</code> saves the options as a small file you can run again next time.
      </p>

      <h2>Push</h2>
      <pre className={pre}>{`underlay push`}</pre>
      <p>
        Push lists what it will copy and asks first. For a public collection, or one that loses many
        records, you type <code>push</code> to go ahead. Versions arrive exactly as you saved them:
        the same numbers and the same ids. If someone pushed first, your versions are rebuilt on
        theirs and you look them over before you push again. <code>underlay pull</code> brings in
        other people's versions.
      </p>

      <h2>The terminal UI</h2>
      <p>
        Plain <code>underlay</code> opens it. The sidebar shows your remotes, the collections on
        your machine and your scripts. The main pane shows a collection, a script's output as it
        runs, the push screen, or a remote's list to add from. Drop a file on the terminal to import
        it. Press <code>,</code> for settings and <code>q</code> to quit.
      </p>

      <h2>Update or remove</h2>
      <p>
        Run the install line again to update. To remove it:{' '}
        <code>rm -rf ~/.local/bin/underlay ~/.local/share/underlay-cli</code>. Your workspace, and
        the records in <code>~/.local/share/underlay</code>, stay until you delete them.
      </p>
      <p>
        <code>underlay --help</code> lists every command.
      </p>
    </DocsLayout>
  )
}
