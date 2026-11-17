import { cliEyebrow } from '~/components/CliDocs'
import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

export default function CliScripts() {
  return (
    <DocsLayout title="Scripts and imports" eyebrow={cliEyebrow}>
      <h2>Scripts</h2>
      <p>
        A script is a <code>.ts</code>, <code>.js</code>, <code>.mjs</code>, <code>.py</code> or{' '}
        <code>.sh</code> file in <code>scripts/</code>, or any executable. Its first lines name the
        collections it writes. When it runs, <code>UNDERLAY_OUT</code> is a folder to write to: one
        NDJSON file for each collection, at{' '}
        <code>&lt;server&gt;/&lt;org&gt;/&lt;name&gt;.ndjson</code>, one record a line.
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

      <h2>What a script declares</h2>
      <table className="border-collapse">
        <tbody>
          <tr>
            <td>
              <code>writes</code>
            </td>
            <td>
              The collections it writes. A script that writes none is a check: it passes or fails.
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
        <code>#</code> in Python and shell). They can also go in a <code>.toml</code> file beside
        the script with the same name, which may set <code>run</code>, the command that runs it.
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
        <code>underlay add-file</code> copies it into <code>inputs/</code>, shows its sheets and
        columns, and finds the collection whose ids it shares.
      </p>
      <CodeBlock>{`underlay add-file ~/Downloads/roster.xlsx
underlay import inputs/roster.xlsx --collection underlay.org/your-org/staff \\
    --type Person --id staff_id`}</CodeBlock>
      <ul>
        <li>
          <code>underlay import</code> saves its options as <code>scripts/imports/roster.toml</code>{' '}
          and runs it. Next month,{' '}
          <code>underlay run imports/roster inputs/roster-2026-12.xlsx</code>.
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
    </DocsLayout>
  )
}
