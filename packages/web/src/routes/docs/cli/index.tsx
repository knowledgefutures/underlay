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
        command, so scripts, cron jobs, and agents can use it as you do. Run plain{' '}
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
        server on your own machine. You sign in to each one separately, and your home can hold
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
        like. <code>underlay update</code> gets the newest build from the same server, and the CLI
        tells you when there is one. To remove the CLI, delete those two paths; your home and its
        records stay.
      </p>

      <h2>Getting started</h2>
      <p>
        From nothing to a pushed version. A collection starts on your machine, with no server or
        sign-in, and you publish it to a server when you want one. The examples use underlay.org;
        for another server, use its address in place of <code>underlay.org</code> (for example{' '}
        <code>staging.underlay.org</code>).
      </p>

      <h3>1. Make your home</h3>
      <p>
        A folder for your collections and your own scripts, at <code>~/Underlay</code>.
      </p>
      <CodeBlock>{`underlay init`}</CodeBlock>

      <h3>2. Start a collection</h3>
      <p>
        A name alone makes one on this machine only. Its versions are numbered here until you
        publish it.
      </p>
      <CodeBlock>{`underlay new scratch`}</CodeBlock>

      <h3>3. Write a script and run it</h3>
      <p>
        Put a JSON Schema for each type in the collection&apos;s folder, as{' '}
        <code>~/Underlay/collections/local/_/scratch/schemas/Thing.json</code>, and a script in{' '}
        <code>~/Underlay/scripts/</code>:
      </p>
      <CodeBlock>{`// ~/Underlay/scripts/scratch.mjs
// underlay: writes scratch
import { writeFileSync } from 'node:fs'

const records = [
  { id: 'a', type: 'Thing', data: { name: 'First' } },
  { id: 'b', type: 'Thing', data: { name: 'Second' } },
]
writeFileSync(
  process.env.UNDERLAY_OUT + '/scratch.ndjson',
  records.map((r) => JSON.stringify(r)).join('\\n'),
)`}</CodeBlock>
      <CodeBlock>{`underlay run scratch
underlay diff scratch     # what the run saved`}</CodeBlock>

      <h3>4. Sign in to a server</h3>
      <p>
        Make an API key on the server&apos;s settings page (on underlay.org,{' '}
        <Link to="/settings/keys">Settings › API keys</Link>), then paste it when asked. On a Mac
        the key is kept in your keychain; elsewhere in a file only you can read.
      </p>
      <CodeBlock>{`underlay login underlay.org
underlay ls               # your organizations' collections, to add with underlay add`}</CodeBlock>

      <h3>5. Publish and push</h3>
      <p>
        Publishing gives the collection its server, org, and name there. Its first push creates it
        with the versions you made, unchanged. Push lists what it will send and asks first.
      </p>
      <CodeBlock>{`underlay publish scratch underlay.org/your-org/scratch
underlay push`}</CodeBlock>
      <p>
        A script names a published collection in full, so change its first line to{' '}
        <code>// underlay: writes underlay.org/your-org/scratch</code> and have it write{' '}
        <code>$UNDERLAY_OUT/underlay.org/your-org/scratch.ndjson</code>. Or run plain{' '}
        <code>underlay</code> and do all of this in the{' '}
        <Link to="/docs/cli/guide#terminal-ui">terminal UI</Link>, where <code>+</code> starts a
        collection and <code>p</code> on it publishes it, signing you in there if you aren&apos;t.
      </p>
    </DocsLayout>
  )
}
