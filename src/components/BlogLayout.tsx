import BaseLayout from '~/components/BaseLayout'

interface BlogLayoutProps {
  children: React.ReactNode
  title: string
  subtitle?: string
  date?: string
}

export default function BlogLayout({ children, title, subtitle, date }: BlogLayoutProps) {
  return (
    <BaseLayout>
      <article className="max-w-2xl mx-auto px-4 py-10">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight font-sans mb-2">{title}</h1>
          {subtitle && <p className="text-ink-muted text-sm italic">{subtitle}</p>}
          {date && (
            <time className="block text-xs text-ink-muted mt-2" dateTime={new Date(date).toISOString().slice(0, 10)}>
              {new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
            </time>
          )}
          <hr className="border-rule mt-4" />
        </header>

        <div className="prose">
          {children}
        </div>
      </article>
    </BaseLayout>
  )
}
