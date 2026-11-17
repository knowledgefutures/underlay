import { CliCommands, cliEyebrow, cliReference } from '~/components/CliDocs'
import DocsLayout from '~/components/DocsLayout'

export default function CliCommandsPage() {
  return (
    <DocsLayout title="Commands" eyebrow={cliEyebrow}>
      <p>
        Every command{cliReference ? ` in v${cliReference.version}` : ''}, as{' '}
        <code>underlay &lt;command&gt; --help</code> gives it. A collection is named as{' '}
        <code>server/org/name</code>, or <code>org/name</code> on your default server, or by its
        name alone when that is unique in your home.
      </p>
      <CliCommands />
    </DocsLayout>
  )
}
