// src/components/ErrorBoundary.tsx
import { Component, type ReactNode } from 'react'
import { QueryErrorResetBoundary } from '@tanstack/react-query'

/**
 * Props and State types
 */
type ErrorBoundaryProps = {
  children: ReactNode
  fallback?: (error: Error, reset: () => void) => ReactNode
}

type ErrorBoundaryState = {
  hasError: boolean
  error: Error | null
}

/**
 * React Error Boundary Class Component
 *
 * Required because error boundaries must be class components
 */
class ErrorBoundaryClass extends Component<
  ErrorBoundaryProps & { onReset?: () => void },
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps & { onReset?: () => void }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log error to error reporting service
    console.error('Error caught by boundary:', error, errorInfo)

    // Example: Send to Sentry, LogRocket, etc.
    // Sentry.captureException(error, { contexts: { react: errorInfo } })
  }

  handleReset = () => {
    // Call TanStack Query reset if provided
    this.props.onReset?.()

    // Reset error boundary state
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError && this.state.error) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleReset)
      }

      // Default error UI
      return (
        <div
          style={{
            padding: '2rem',
            border: '2px solid #ef4444',
            borderRadius: '8px',
            backgroundColor: '#fee',
          }}
        >
          <h2>Something went wrong</h2>
          <details style={{ whiteSpace: 'pre-wrap', marginTop: '1rem' }}>
            <summary>Error details</summary>
            {this.state.error.message}
            {this.state.error.stack && (
              <pre style={{ marginTop: '1rem', fontSize: '0.875rem' }}>
                {this.state.error.stack}
              </pre>
            )}
          </details>
          <button
            onClick={this.handleReset}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              backgroundColor: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

/**
 * Error Boundary with TanStack Query Reset
 *
 * Wraps components and catches errors thrown by queries
 * with throwOnError: true
 */
export function ErrorBoundary({ children, fallback }: ErrorBoundaryProps) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundaryClass onReset={reset} fallback={fallback}>
          {children}
        </ErrorBoundaryClass>
      )}
    </QueryErrorResetBoundary>
  )
}

/**
 * Usage Examples
 */

// Example 1: Wrap entire app
export function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}

// Example 2: Wrap specific features
export function UserProfileWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <UserProfile />
    </ErrorBoundary>
  )
}

// Example 3: Custom error UI
export function CustomErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div className="error-container">
          <h1>Oops!</h1>
          <p>We encountered an error: {error.message}</p>
          <button onClick={reset}>Retry</button>
          <a href="/">Go Home</a>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}

/**
 * Using throwOnError with Queries
 *
 * Queries can throw errors to error boundaries
 */
import { useQuery } from '@tanstack/react-query'

// Example 1: Always throw errors
function UserData({ id }: { id: number }) {
  const { data } = useQuery({
    queryKey: ['user', id],
    queryFn: async () => {
      const response = await fetch(`/api/users/${id}`)
      if (!response.ok) throw new Error('User not found')
      return response.json()
    },
    throwOnError: true, // Throw to error boundary
  })

  return <div>{data.name}</div>
}

// Example 2: Conditional throwing (only server errors)
function ConditionalErrorThrowing({ id }: { id: number }) {
  const { data } = useQuery({
    queryKey: ['user', id],
    queryFn: async () => {
      const response = await fetch(`/api/users/${id}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    },
    throwOnError: (error) => {
      // Only throw 5xx server errors to boundary
      // Handle 4xx client errors locally
      return error.message.includes('5')
    },
  })

  return <div>{data?.name ?? 'Not found'}</div>
}

/**
 * Multiple Error Boundaries (Layered)
 *
 * Place boundaries at different levels for granular error handling
 */
export function LayeredErrorBoundaries() {
  return (
    // App-level boundary
    <ErrorBoundary fallback={(error) => <AppCrashScreen error={error} />}>
      <Header />

      {/* Feature-level boundary */}
      <ErrorBoundary fallback={(error) => <FeatureError error={error} />}>
        <UserProfile />
      </ErrorBoundary>

      {/* Another feature boundary */}
      <ErrorBoundary>
        <TodoList />
      </ErrorBoundary>

      <Footer />
    </ErrorBoundary>
  )
}

/**
 * Key concepts:
 *
 * 1. QueryErrorResetBoundary: Provides reset function for TanStack Query
 * 2. throwOnError: Makes query throw errors to boundary
 * 3. Layered boundaries: Isolate failures to specific features
 * 4. Custom fallbacks: Control error UI per boundary
 * 5. Error logging: componentDidCatch for monitoring
 *
 * Best practices:
 * ✅ Always wrap app in error boundary
 * ✅ Use throwOnError for critical errors only
 * ✅ Provide helpful error messages to users
 * ✅ Log errors to monitoring service
 * ✅ Offer reset/retry functionality
 * ❌ Don't catch all errors - use local error states when appropriate
 * ❌ Don't throw for expected errors (404, validation)
 */
