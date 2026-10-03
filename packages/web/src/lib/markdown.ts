/**
 * Markdown to HTML for collection READMEs, safe to inject without a DOM sanitizer.
 *
 * v1 sanitized marked's output with isomorphic-dompurify, which needs jsdom on the
 * server: too heavy for a Worker, and the output must be identical on server and
 * client for hydration. Instead the renderer never emits author HTML: raw HTML in
 * the source is escaped and shown as text, and link and image URLs are limited to
 * http(s), mailto and relative ones. Everything else marked emits is built from
 * escaped text, so the result is safe as-is.
 */
import { Marked } from 'marked'

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** Absolute http(s)/mailto URLs, and relative ones (no scheme at all). */
function safeUrl(href: string): boolean {
  // Browsers drop whitespace and control characters inside a scheme, so
  // "java\tscript:" must be judged as "javascript:".
  // oxlint-disable-next-line no-control-regex
  const cleaned = href.replace(/[\u0000- \u007f]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned)
  if (!scheme) return true
  return ['http', 'https', 'mailto'].includes(scheme[1]!.toLowerCase())
}

const md = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens)
      if (!safeUrl(href)) return inner
      const t = title ? ` title="${escapeHtml(title)}"` : ''
      return `<a href="${escapeHtml(href)}"${t} rel="noopener noreferrer">${inner}</a>`
    },
    image({ href, title, text }) {
      if (!safeUrl(href)) return escapeHtml(text)
      const t = title ? ` title="${escapeHtml(title)}"` : ''
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${t} loading="lazy" />`
    },
  },
})

export function renderMarkdown(source: string): string {
  return md.parse(source, { async: false })
}
