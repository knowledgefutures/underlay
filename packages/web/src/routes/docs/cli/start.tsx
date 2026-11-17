import { Link, useLoaderData } from 'react-router'

import { cliEyebrow, installLine } from '~/components/CliDocs'
import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

export default function CliStart() {
  const { origin } = useLoaderData() as { origin: string }
  return (
    <DocsLayout title="Getting started" eyebrow={cliEyebrow}>
      <p>
        From nothing to a pushed version. The examples use underlay.org; for another server, use its
        address in place of <code>underlay.org</code> (for example <code>staging.underlay.org</code>
        , or <code>localhost:3000</code> for one on your machine). Use a scratch collection while
        you try it.
      </p>

      <h2>1. Install</h2>
      <CodeBlock>{installLine(origin)}</CodeBlock>

      <h2>2. Sign in</h2>
      <p>
        Make an API key on the server&apos;s settings page (on underlay.org,{' '}
        <Link to="/settings/keys">Settings › API keys</Link>), then paste it when asked. On a Mac
        the key is kept in your keychain; elsewhere in a file only you can read.
      </p>
      <CodeBlock>{`underlay login underlay.org
underlay remotes          # where you are signed in`}</CodeBlock>

      <h2>3. Make a workspace</h2>
      <p>
        A folder for your collections, scripts and views. Set the server your collections usually
        come from, so you can leave it out of collection names.
      </p>
      <CodeBlock>{`underlay init ~/Underlay
cd ~/Underlay
underlay config set defaults.remote underlay.org`}</CodeBlock>

      <h2>4. Add a collection, or start one</h2>
      <CodeBlock>{`underlay ls                                  # your organizations' collections
underlay add underlay.org/your-org/a-collection
underlay new underlay.org/your-org/scratch   # not there yet: your first push creates it`}</CodeBlock>

      <h2>5. Write a script and run it</h2>
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

      <h2>6. Push</h2>
      <CodeBlock>{`underlay push`}</CodeBlock>
      <p>
        Push lists what it will send and asks first. Or run plain <code>underlay</code> and do all
        of this in the <Link to="/docs/cli/ui">terminal UI</Link>.
      </p>
    </DocsLayout>
  )
}
