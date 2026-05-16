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
      <article className="mx-auto max-w-2xl px-4 py-10">
        <header className="mb-8">
          <h1 className="mb-2 font-sans text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-ink-muted text-sm italic">{subtitle}</p>}
          {date && (
            <time
              className="text-ink-muted mt-2 block text-xs"
              dateTime={new Date(date).toISOString().slice(0, 10)}
            >
              {new Date(date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </time>
          )}
          <hr className="border-rule mt-4" />
        </header>

        <div className="prose">{children}</div>
      </article>
    </BaseLayout>
  )
}
