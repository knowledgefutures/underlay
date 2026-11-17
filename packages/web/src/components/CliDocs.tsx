/**
 * What the CLI docs (/docs/cli/*) share: its screenshots and its command reference, both
 * made from the CLI itself at every build (scripts/cli-assets.ts), so they match the CLI
 * this deployment serves at /cli/install.sh.
 */
import { useState } from 'react'

export interface CliReference {
  version: string
  groups: {
    title: string
    commands: {
      name: string
      usage: string
      description: string
      options: { flags: string; description: string }[]
    }[]
  }[]
}

// Absent until the first build makes it (a typecheck runs before any build).
const generated = import.meta.glob<CliReference>('../generated/cli-reference.json', {
  eager: true,
  import: 'default',
})
export const cliReference: CliReference | null = Object.values(generated)[0] ?? null

/** The line above a CLI page's title. */
export const cliEyebrow = `underlay${cliReference ? ` v${cliReference.version}` : ''} · preview`

/** The install line, for the site the page is on: it downloads that site's build. */
export const installLine = (origin: string) => `curl -fsSL ${origin}/cli/install.sh | sh`

/** The site's own address, for the install line. */
export function originLoader({ request }: { request: Request }) {
  return { origin: new URL(request.url).origin }
}

const SHOTS = [
  { key: 'collection', label: 'A collection' },
  { key: 'run', label: 'A finished run' },
  { key: 'push', label: 'Push' },
  { key: 'help', label: 'Keys' },
  { key: 'settings', label: 'Settings' },
] as const

export function CliScreens({
  initial = 'collection',
}: {
  initial?: (typeof SHOTS)[number]['key']
}) {
  const [shot, setShot] = useState<(typeof SHOTS)[number]['key']>(initial)
  const current = SHOTS.find((s) => s.key === shot)!
  return (
    <figure className="mt-4 mb-6">
      <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Screens">
        {SHOTS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={s.key === shot}
            onClick={() => setShot(s.key)}
            className={`rounded-control px-2.5 py-1 text-xs font-medium transition-colors ${
              s.key === shot ? 'bg-ink text-parchment' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-[8px]">
        <img
          src={`/cli/screenshot-${current.key}.svg`}
          alt={`The terminal UI: ${current.label.toLowerCase()}`}
          width={1145}
          height={716}
          className="block h-auto w-full min-w-[640px]"
        />
      </div>
      <figcaption className="text-ink-muted mt-2 text-xs">
        The terminal UI, drawn by this version of the CLI when the site was built. The organizations
        in it are made up.
      </figcaption>
    </figure>
  )
}

export function CliCommands() {
  if (!cliReference)
    return (
      <p>
        Run <code>underlay --help</code>, or <code>underlay &lt;command&gt; --help</code>.
      </p>
    )
  return (
    <>
      {cliReference.groups.map((g) => (
        <div key={g.title}>
          <h2>{g.title}</h2>
          <table className="border-collapse">
            <tbody>
              {g.commands.map((c) => (
                <tr key={c.name} id={`cmd-${c.name.replace(/\s+/g, '-')}`}>
                  <td style={{ width: '42%' }} className="font-mono">
                    {c.usage}
                  </td>
                  <td>
                    {c.description}
                    {c.options.map((o) => (
                      <div key={o.flags} className="text-ink-muted mt-0.5">
                        <span className="text-ink font-mono">{o.flags}</span>
                        {o.description ? ` ${o.description}` : ''}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  )
}
