import { Component, type ReactNode } from 'react'
import { isRouteErrorResponse, useRouteError, useRouteLoaderData } from 'react-router'

import BaseLayout from '~/components/BaseLayout'

export class NotFoundError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export default function NotFound({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-24">
      <p className="text-ink-muted mb-6 text-7xl font-extralight tracking-tight select-none">404</p>
      <h1 className="text-ink mb-2 text-lg font-medium">Page not found</h1>
      {message && <p className="text-ink-muted mb-6 text-sm">{message}</p>}
      {!message && <div className="mb-6" />}
      <a href="/" className="text-ink-muted hover:text-ink text-sm transition-colors">
        &larr; Back to home
      </a>
    </div>
  )
}

/**
 * Route-level error boundary for the data router. Loader-thrown Responses
 * (404s and friends) land here — without this, react-router renders its
 * built-in developer error page.
 */
export function RouteErrorBoundary() {
  const error = useRouteError()
  // BaseLayout reads the root loader's data; fall back to bare content if it's absent.
  const rootData = useRouteLoaderData('root')

  const content =
    isRouteErrorResponse(error) && error.status === 404 ? (
      <NotFound />
    ) : (
      <div className="flex flex-col items-center justify-center px-4 py-24">
        <p className="text-ink-muted mb-6 text-5xl font-extralight tracking-tight select-none">
          {isRouteErrorResponse(error) ? error.status : 'Error'}
        </p>
        <h1 className="text-ink mb-2 text-lg font-medium">Something went wrong</h1>
        <p className="text-ink-muted mb-6 text-sm">
          {isRouteErrorResponse(error)
            ? error.statusText
            : error instanceof Error
              ? error.message
              : ''}
        </p>
        <a href="/" className="text-ink-muted hover:text-ink text-sm transition-colors">
          &larr; Back to home
        </a>
      </div>
    )

  return rootData ? <BaseLayout>{content}</BaseLayout> : content
}

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch() {
    // Could log to an error service here
  }

  render() {
    if (this.state.error instanceof NotFoundError) {
      return (
        <BaseLayout>
          <NotFound message={this.state.error.message} />
        </BaseLayout>
      )
    }
    if (this.state.error) {
      return (
        <BaseLayout>
          <div className="flex flex-col items-center justify-center px-4 py-24">
            <p className="text-ink-muted mb-6 text-5xl font-extralight tracking-tight select-none">
              Error
            </p>
            <h1 className="text-ink mb-2 text-lg font-medium">Something went wrong</h1>
            <p className="text-ink-muted mb-6 text-sm">{this.state.error.message}</p>
            <a href="/" className="text-ink-muted hover:text-ink text-sm transition-colors">
              &larr; Back to home
            </a>
          </div>
        </BaseLayout>
      )
    }
    return this.props.children
  }
}
