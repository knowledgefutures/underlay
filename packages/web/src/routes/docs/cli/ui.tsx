import { cliEyebrow, CliScreens } from '~/components/CliDocs'
import DocsLayout from '~/components/DocsLayout'

const KEYS: [string, string][] = [
  ['↑ ↓', 'Move through the sidebar'],
  ['tab', 'Move between the sidebar and the main pane'],
  ['← →', 'Switch a collection’s tabs'],
  ['r', 'Run the selected script, or one that writes the selected collection'],
  ['x, space, R', 'While a script runs: cancel, pause or resume, restart'],
  ['u', 'Undo the newest version not yet pushed, or a finished run’s versions'],
  ['l', 'Pull the selected collection'],
  ['k', 'Keep all, some, or none of the selected collection'],
  ['p', 'Push'],
  ['+', 'Add collections from a remote'],
  ['f', 'Add a file (or drop one on the terminal)'],
  ['h', 'Every run'],
  [',', 'Settings'],
  ['c, C', 'Copy a prompt for an agent; send it to the handoff command'],
  ['o', 'Open the collection on its server'],
  ['q', 'Quit'],
]

export default function CliUi() {
  return (
    <DocsLayout title="Terminal UI" eyebrow={cliEyebrow}>
      <p>
        Plain <code>underlay</code> in a terminal opens it, in the workspace you are in (or your
        default one). It calls the same code as the commands and watches the workspace, so what a
        command, another terminal, or an agent does shows up as it happens.
      </p>
      <CliScreens />

      <h2>Layout</h2>
      <ul>
        <li>
          <strong>Remotes</strong>: the servers you can use, whether you are signed in, and how many
          of your organizations&apos; collections there are on your machine.
        </li>
        <li>
          <strong>On this machine</strong>: your collections, by authority and organization, with
          what is kept and how each stands against its authority.
        </li>
        <li>
          <strong>Scripts and views</strong>: each script with its last result, and your views.
        </li>
        <li>
          The main pane shows what is selected: a collection (Overview, Records, Schemas, Files,
          Changes, Versions), a script&apos;s output as it runs, a finished run, the push screen, a
          remote&apos;s list of collections to add, a file you added, or settings.
        </li>
      </ul>

      <h2>Keys</h2>
      <p>The keys for the screen you are on are along the bottom.</p>
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
    </DocsLayout>
  )
}
