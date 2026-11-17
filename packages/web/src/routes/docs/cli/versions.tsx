import { Link } from 'react-router'

import { CliScreens, cliEyebrow } from '~/components/CliDocs'
import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

export default function CliVersions() {
  return (
    <DocsLayout title="Versions, pull and push" eyebrow={cliEyebrow}>
      <p>
        A version is saved on your machine by a run, an import, or <code>underlay save</code>. It is
        a real version of the collection, with its number and id, but nobody else sees it until you
        push it.
      </p>

      <h2>Review and change</h2>
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
      <CliScreens initial="push" />
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
    </DocsLayout>
  )
}
