import { cliEyebrow } from '~/components/CliDocs'
import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

export default function CliWorkspaces() {
  return (
    <DocsLayout title="Workspaces" eyebrow={cliEyebrow}>
      <p>
        A workspace is a folder for your collections, scripts and views. It is plain files, so you
        can commit it to git and share it. <code>underlay init</code> makes one.
      </p>

      <h2>Layout</h2>
      <table className="border-collapse">
        <tbody>
          <tr>
            <td>
              <code>underlay.toml</code>
            </td>
            <td>The workspace&apos;s remotes and defaults.</td>
          </tr>
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
              Scripts that write collections, and saved imports in <code>scripts/imports/</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>views/</code>
            </td>
            <td>Small static pages for looking at results.</td>
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
          <tr>
            <td>
              <code>.underlay/</code>
            </td>
            <td>This machine&apos;s run history and locks. Ignored by git.</td>
          </tr>
        </tbody>
      </table>

      <h2>What is kept on your machine</h2>
      <p>
        Records are not kept in the workspace. They live in the store,{' '}
        <code>~/.local/share/underlay</code> by default, with versions not yet pushed and run logs.
        A record file is kept once however many collections name it.
      </p>
      <p>
        <code>underlay add</code> keeps all of a collection&apos;s records. With{' '}
        <code>--keep none</code>, only its schemas and history are kept, and records are fetched
        from its authority when something reads them; <code>--keep some --types A,B</code> keeps
        some types. <code>underlay keep</code> and <code>underlay forget</code> change this later.
      </p>
      <table className="border-collapse">
        <tbody>
          {[
            ['■', 'All of the collection’s records are here'],
            ['◧', 'Some of them'],
            ['□', 'Its schemas and history only'],
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
        Your own settings are in <code>~/.config/underlay/config.toml</code>: the store, your
        workspaces, where keys are kept. The workspace&apos;s are in <code>underlay.toml</code> and
        win where both set something, except paths, which stay yours. <code>underlay config</code>{' '}
        lists every setting and where it is set.
      </p>
      <CodeBlock>{`underlay config
underlay config set defaults.remote underlay.org
underlay config set store.path /Volumes/Data/underlay --personal`}</CodeBlock>
      <p>
        A store rule sends some collections&apos; records somewhere else, or sets how much of them
        is kept. The most specific match wins.
      </p>
      <CodeBlock>{`underlay config rule add 'underlay.org/your-org/*' --keep all
underlay config rule add 'underlay.org/your-org/private' --path ~/Private/underlay`}</CodeBlock>

      <h2>Agents</h2>
      <p>
        An agent works in a workspace with the same commands you use, and reads{' '}
        <code>AGENTS.md</code> to learn how. <code>underlay status --json</code> gives it the state
        of everything. Agents save versions; pushing is yours to do.
      </p>
      <p>
        To hand work to an agent from the terminal UI, <code>c</code> copies a prompt about what you
        are looking at, and <code>C</code> sends it to the command set in <code>handoff.send</code>,
        which takes the prompt on its standard input.
      </p>
      <CodeBlock>{`underlay config set handoff.send 'your-agent-command -'`}</CodeBlock>
    </DocsLayout>
  )
}
