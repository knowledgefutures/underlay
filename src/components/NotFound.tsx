import { Component, type ReactNode, } from 'react'
import BaseLayout from '~/components/BaseLayout'

export class NotFoundError extends Error {
  constructor(message?: string,) {
    super(message,)
    this.name = 'NotFoundError'
  }
}

export default function NotFound({ message, }: { message?: string },) {
  return (
    <div className='flex flex-col items-center justify-center py-24 px-4'>
      <p className='text-7xl font-extralight tracking-tight text-ink-muted select-none mb-6'>
        404
      </p>
      <h1 className='text-lg font-medium text-ink mb-2'>
        Page not found
      </h1>
      {message && (
        <p className='text-sm text-ink-muted mb-6'>
          {message}
        </p>
      )}
      {!message && <div className='mb-6' />}
      <a
        href='/'
        className='text-sm text-ink-muted hover:text-ink transition-colors'
      >
        &larr; Back to home
      </a>
    </div>
  )
}

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props,) {
    super(props,)
    this.state = { error: null, }
  }

  static getDerivedStateFromError(error: Error,) {
    return { error, }
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
          <div className='flex flex-col items-center justify-center py-24 px-4'>
            <p className='text-5xl font-extralight tracking-tight text-ink-muted select-none mb-6'>
              Error
            </p>
            <h1 className='text-lg font-medium text-ink mb-2'>
              Something went wrong
            </h1>
            <p className='text-sm text-ink-muted mb-6'>
              {this.state.error.message}
            </p>
            <a
              href='/'
              className='text-sm text-ink-muted hover:text-ink transition-colors'
            >
              &larr; Back to home
            </a>
          </div>
        </BaseLayout>
      )
    }
    return this.props.children
  }
}
