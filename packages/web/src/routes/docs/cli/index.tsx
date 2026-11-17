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

      <h2>In this section</h2>
      <ul>
        <li>
          <Link to="/docs/cli/start">Getting started</Link>: from installing to your first pushed
          version.
        </li>
        <li>
          <Link to="/docs/cli/workspaces">Workspaces</Link>: the folder, what is kept on your
          machine, settings, and agents.
        </li>
        <li>
          <Link to="/docs/cli/scripts">Scripts and imports</Link>: how scripts write collections,
          and importing a file without one.
        </li>
        <li>
          <Link to="/docs/cli/versions">Versions, pull and push</Link>: reviewing and changing
          versions before they leave your machine.
        </li>
        <li>
          <Link to="/docs/cli/ui">Terminal UI</Link>: its screens and keys.
        </li>
        <li>
          <Link to="/docs/cli/commands">Commands</Link>: every command and option.
        </li>
      </ul>
    </DocsLayout>
  )
}
