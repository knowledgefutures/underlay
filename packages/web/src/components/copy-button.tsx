import { useState } from 'react'

/** A small button that copies `text`, and says so for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="border-rule text-ink-muted hover:text-ink hover:bg-parchment-dark rounded-control cursor-pointer border px-2 py-0.5 text-xs transition-colors"
    >
      {copied ? 'Copied' : label}
    </button>
  )
}
