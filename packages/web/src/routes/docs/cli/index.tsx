import { Link, useLoaderData } from 'react-router'

import { cliEyebrow, CliScreens, installLine } from '~/components/CliDocs'
import DocsLayout, { CodeBlock } from '~/components/DocsLayout'
import { HELP_EMAIL } from '~/lib/contact'

export default function CliOverview() {
  const { origin } = useLoaderData() as { origin: string }
  return (
    <DocsLayout title="The Underlay CLI" eyebrow={cliEyebrow}>
      <p>
        <code>underlay</code> is a command-line client for Underlay collections. It keeps
        collections on your machine, runs the scripts that write new versions of them, shows what
        changed, and pushes the versions to the server the collection lives on. Every action is a
        command, so scripts, cron jobs and agents can use it as you do. Run plain{' '}
        <code>underlay</code> in a terminal to open its terminal UI.
      </p>
      <p>
        It is a preview and changes often. Push to a scratch collection while you try it, and write
        to <a href={`mailto:${HELP_EMAIL}`}>{HELP_EMAIL}</a> about anything that gets in your way.
      </p>

      <CliScreens />

      <h2>Servers</h2>
      <p>
        The CLI works with any server that speaks the{' '}
        <Link to="/docs/protocol">Underlay protocol</Link>: underlay.org, a staging server, or a
        server on your own machine. You sign in to each one separately, and a workspace can hold
        collections from several. Each collection has an <em>authority</em>, the one server that
        accepts and numbers its versions, and the CLI pushes each collection to its own.
      </p>
      <p>
        Pushing and pulling use the protocol&apos;s routes for commits built by their author and for
        following a collection (<Link to="/docs/protocol/push-and-pull">Push and pull</Link>).
        Listing your organizations&apos; collections (<code>underlay ls</code>) uses
        underlay.org&apos;s account routes, which are not part of the protocol.
      </p>

      <h2>Install</h2>
      <p>
        You need <a href="https://nodejs.org">Node.js</a> 22.6 or later, on macOS or Linux.
      </p>
      <CodeBlock>{installLine(origin)}</CodeBlock>
      <p>
        The script downloads the CLI (one JavaScript file) to{' '}
        <code>~/.local/share/underlay-cli</code>, checks it against its SHA-256, and puts an{' '}
        <code>underlay</code> command in <code>~/.local/bin</code>. It tells you if that folder is
        not on your PATH. <a href="/cli/install.sh">Read the script</a> before you run it if you
        like. Run the same line again to update. To remove the CLI, delete those two paths; your
        workspaces and their records stay.
      </p>

      <h2>Getting started</h2>
      <p>
        From nothing to a pushed version. The examples use underlay.org; for another server, use its
        address in place of <code>underlay.org</code> (for example <code>staging.underlay.org</code>
        , or <code>localhost:3000</code> for one on your machine). Use a scratch collection while
        you try it.
      </p>

      <h3>1. Sign in</h3>
      <p>
        Make an API key on the server&apos;s settings page (on underlay.org,{' '}
        <Link to="/settings/keys">Settings › API keys</Link>), then paste it when asked. On a Mac
        the key is kept in your keychain; elsewhere in a file only you can read.
      </p>
      <CodeBlock>{`underlay login underlay.org
underlay remotes          # where you are signed in`}</CodeBlock>

      <h3>2. Make a workspace</h3>
      <p>
        A folder for your collections, scripts and views. Set the server your collections usually
        come from, so you can leave it out of collection names.
      </p>
      <CodeBlock>{`underlay init ~/Underlay
cd ~/Underlay
underlay config set defaults.remote underlay.org`}</CodeBlock>

      <h3>3. Add a collection, or start one</h3>
      <CodeBlock>{`underlay ls                                  # your organizations' collections
underlay add underlay.org/your-org/a-collection
underlay new underlay.org/your-org/scratch   # not there yet: your first push creates it`}</CodeBlock>

      <h3>4. Write a script and run it</h3>
      <p>
        Put a JSON Schema for each type in the collection&apos;s folder, as{' '}
        <code>collections/underlay.org/your-org/scratch/schemas/Thing.json</code>, and a script in{' '}
        <code>scripts/</code>:
      </p>
      <CodeBlock>{`// scripts/scratch.mjs
// underlay: writes underlay.org/your-org/scratch
import { mkdirSync, writeFileSync } from 'node:fs'

const dir = process.env.UNDERLAY_OUT + '/underlay.org/your-org'
mkdirSync(dir, { recursive: true })

const records = [
  { id: 'a', type: 'Thing', data: { name: 'First' } },
  { id: 'b', type: 'Thing', data: { name: 'Second' } },
]
writeFileSync(dir + '/scratch.ndjson', records.map((r) => JSON.stringify(r)).join('\\n'))`}</CodeBlock>
      <CodeBlock>{`underlay run scratch
underlay diff scratch     # what the run saved`}</CodeBlock>

      <h3>5. Push</h3>
      <CodeBlock>{`underlay push`}</CodeBlock>
      <p>
        Push lists what it will send and asks first. Or run plain <code>underlay</code> and do all
        of this in the <Link to="/docs/cli/guide#terminal-ui">terminal UI</Link>.
      </p>
    </DocsLayout>
  )
}
