/**
 * Org settings for the org's page (`/:owner/settings/page`): its cover (a color, and an
 * image over it, tinted or not), pinned collections, and a provenance note. The image
 * uploads when it's picked, as the logo does; the rest saves with the button.
 */
import { type FormEvent, useState } from 'react'

import {
  COVER_COLORS,
  Cover,
  coverColorFor,
  type OrgCollection,
  OrgLogo,
} from '~/components/org-page'
import { Alert, Button, Checkbox, Input, Select } from '~/components/ui'

const MAX_PINNED = 4

export default function OrgPageSettings({
  owner,
  org,
  initial,
  collections,
}: {
  owner: string
  /** The org as its page shows it, for the preview. */
  org: { displayName: string; avatarUrl: string | null }
  initial: {
    coverColor: string | null
    coverImageUrl: string | null
    coverTint: boolean
    pinned: string[]
    provenanceNote: string | null
  }
  collections: OrgCollection[]
}) {
  const [coverColor, setCoverColor] = useState<string | null>(initial.coverColor)
  const [custom, setCustom] = useState(
    initial.coverColor && !COVER_COLORS.includes(initial.coverColor) ? initial.coverColor : '',
  )
  const [pinned, setPinned] = useState<string[]>(
    initial.pinned.filter((id) => collections.some((c) => c.id === id)),
  )
  const [note, setNote] = useState(initial.provenanceNote ?? '')
  const [coverImageUrl, setCoverImageUrl] = useState(initial.coverImageUrl)
  const [coverTint, setCoverTint] = useState(initial.coverTint)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const byId = new Map(collections.map((c) => [c.id, c]))
  const unpinned = collections.filter((c) => !pinned.includes(c.id))
  const automatic = coverColorFor({ slug: owner, coverColor: null })

  const move = (i: number, by: number) =>
    setPinned((p) => {
      const next = [...p]
      const [id] = next.splice(i, 1)
      next.splice(i + by, 0, id!)
      return next
    })

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/accounts/${owner}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ coverColor, coverTint, pinned, provenanceNote: note }),
      })
      const body = await res.json().catch(() => ({}))
      setMessage(
        res.ok
          ? { ok: true, text: 'Page settings saved.' }
          : { ok: false, text: body.error ?? 'Save failed.' },
      )
    } finally {
      setSaving(false)
    }
  }

  /** Uploads as soon as a file is picked, or removes the image: one button each. */
  async function changeImage(file: File | null) {
    setUploading(true)
    setMessage(null)
    try {
      let res: Response
      if (file) {
        const form = new FormData()
        form.append('cover', file)
        res = await fetch(`/api/accounts/${owner}/cover`, {
          method: 'POST',
          credentials: 'include',
          body: form,
        })
      } else {
        res = await fetch(`/api/accounts/${owner}/cover`, {
          method: 'DELETE',
          credentials: 'include',
        })
      }
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        setCoverImageUrl(file ? body.coverImageUrl : null)
        setMessage({ ok: true, text: file ? 'Cover image updated.' : 'Cover image removed.' })
      } else {
        setMessage({ ok: false, text: body.error ?? 'Upload failed.' })
      }
    } finally {
      setUploading(false)
    }
  }

  const swatch = (color: string | null, label: string) => {
    const on = coverColor === color
    return (
      <label
        key={label}
        title={label}
        className={`relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-[6px] ${
          on ? 'ring-ink ring-2 ring-offset-2' : ''
        }`}
        style={{ backgroundColor: color ?? automatic }}
      >
        <input
          type="radio"
          name="cover"
          className="sr-only"
          checked={on}
          onChange={() => setCoverColor(color)}
        />
        <span className="sr-only">{label}</span>
        {color === null && (
          <span aria-hidden="true" className="text-[10px] font-semibold text-white">
            Auto
          </span>
        )}
      </label>
    )
  }

  return (
    <form onSubmit={save} className="mb-10 space-y-6">
      {message && <Alert variant={message.ok ? 'success' : 'error'}>{message.text}</Alert>}

      <div>
        <p className="mb-1 text-sm font-medium">Cover</p>
        <p className="text-ink-muted mb-3 text-xs">
          The band across the top of the page, behind the logo.
        </p>
        {/* The top of the page as visitors will see it, changing as you edit. */}
        <div className="border-rule rounded-surface overflow-hidden border">
          <Cover account={{ slug: owner, coverColor, coverImageUrl, coverTint }} className="h-28" />
          <div className="-mt-3 flex items-end gap-3 px-4 pb-4">
            <OrgLogo
              account={{ ...org, slug: owner, coverColor }}
              size="md"
              className="ring-parchment relative z-10 ring-4"
            />
            <div className="min-w-0 pb-0.5">
              <p className="truncate text-lg leading-tight font-bold">{org.displayName}</p>
              <p className="text-ink-muted font-mono text-xs">@{owner}</p>
            </div>
          </div>
        </div>
      </div>

      <fieldset>
        <legend className="mb-1 text-sm font-medium">Cover image</legend>
        <p className="text-ink-muted mb-3 text-xs">
          Optional. A wide photo or graphic, at least 1600 pixels across. JPEG, PNG, GIF or WebP, up
          to 3 MiB.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label
            className={`border-rule bg-parchment hover:bg-parchment-dark rounded-control inline-flex cursor-pointer items-center border px-2.5 py-1 text-xs font-medium transition-colors focus-within:outline-2 ${uploading ? 'pointer-events-none opacity-60' : ''}`}
          >
            <input
              type="file"
              name="cover"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="sr-only"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void changeImage(file)
              }}
            />
            {uploading ? 'Uploading…' : coverImageUrl ? 'Replace image…' : 'Upload image…'}
          </label>
          {coverImageUrl && (
            <Button
              size="sm"
              variant="ghost"
              disabled={uploading}
              onClick={() => void changeImage(null)}
            >
              Remove
            </Button>
          )}
        </div>
        {coverImageUrl && (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <Checkbox
              checked={coverTint}
              onChange={(e) => setCoverTint(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Tint the image with the cover color
              <span className="text-ink-muted block text-xs">
                Keeps a busy photo quiet behind the logo. Saved with the button below.
              </span>
            </span>
          </label>
        )}
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-medium">Cover color</legend>
        <p className="text-ink-muted mb-3 text-xs">
          {coverImageUrl
            ? 'Shows while the image loads, and tints it when that is on.'
            : 'Auto picks one from the slug.'}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {swatch(null, 'Automatic')}
          {COVER_COLORS.map((c) => swatch(c, c))}
          <label className="flex items-center gap-2 text-xs">
            <input
              type="color"
              value={custom || coverColor || automatic}
              onChange={(e) => {
                setCustom(e.target.value)
                setCoverColor(e.target.value)
              }}
              className="h-9 w-9 cursor-pointer"
            />
            Your own
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-medium">Pinned collections</legend>
        <p className="text-ink-muted mb-3 text-xs">
          Up to {MAX_PINNED}, shown as large cards above the full list when the organization has
          more than {MAX_PINNED} collections, and first otherwise.
        </p>
        {pinned.length > 0 && (
          <ol className="border-rule rounded-surface mb-3 border">
            {pinned.map((id, i) => (
              <li
                key={id}
                className="border-rule flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium">{byId.get(id)?.name}</span>{' '}
                  <span className="text-ink-muted font-mono text-xs">{byId.get(id)?.slug}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${byId.get(id)?.name} up`}
                >
                  Up
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={i === pinned.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${byId.get(id)?.name} down`}
                >
                  Down
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPinned((p) => p.filter((x) => x !== id))}
                  aria-label={`Unpin ${byId.get(id)?.name}`}
                >
                  Unpin
                </Button>
              </li>
            ))}
          </ol>
        )}
        {pinned.length < MAX_PINNED && unpinned.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor="pin-add" className="text-sm">
              Pin
            </label>
            <Select
              id="pin-add"
              value=""
              onChange={(e) => e.target.value && setPinned((p) => [...p, e.target.value])}
            >
              <option value="">Choose a collection</option>
              {unpinned.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.public ? '' : ' (private)'}
                </option>
              ))}
            </Select>
          </div>
        )}
        {collections.length === 0 && (
          <p className="text-ink-muted text-sm">No collections to pin yet.</p>
        )}
      </fieldset>

      <div>
        <label htmlFor="provenanceNote" className="mb-1 block text-sm font-medium">
          Provenance note
        </label>
        <Input
          id="provenanceNote"
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Imported by … Not maintained or endorsed by …"
        />
        <p className="text-ink-muted mt-1 text-xs">
          For data published on someone else's behalf: who made it, and who does not stand behind
          it. Shown under the organization's name in small type.
        </p>
      </div>

      <Button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save page settings'}
      </Button>
    </form>
  )
}
