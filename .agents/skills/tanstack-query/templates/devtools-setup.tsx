// src/main.tsx - Complete DevTools Setup
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import App from './App'

/**
 * QueryClient with DevTools-friendly configuration
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 60,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />

      {/*
        ReactQueryDevtools Configuration

        IMPORTANT: DevTools are automatically tree-shaken in production
        Safe to leave in code, won't appear in production bundle
      */}
      <ReactQueryDevtools
        // Start collapsed (default: false)
        initialIsOpen={false}

        // Button position on screen
        buttonPosition="bottom-right" // "top-left" | "top-right" | "bottom-left" | "bottom-right"

        // Panel position when open
        position="bottom" // "top" | "bottom" | "left" | "right"

        // Custom styles for toggle button
        toggleButtonProps={{
          style: {
            marginBottom: '4rem', // Move up if button overlaps content
            marginRight: '1rem',
          },
        }}

        // Custom styles for panel
        panelProps={{
          style: {
            height: '400px', // Custom panel height
          },
        }}

        // Add keyboard shortcut (optional)
        // Default: None, but you can add custom handler
      />
    </QueryClientProvider>
  </StrictMode>
)

/**
 * Advanced: Conditional DevTools (explicit dev check)
 *
 * DevTools are already removed in production, but can add explicit check
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      {import.meta.env.DEV && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  </StrictMode>
)

/**
 * Advanced: Custom Toggle Button
 */
import { useState } from 'react'

function AppWithCustomDevTools() {
  const [showDevTools, setShowDevTools] = useState(false)

  return (
    <QueryClientProvider client={queryClient}>
      <App />

      {/* Custom toggle button */}
      <button
        onClick={() => setShowDevTools(!showDevTools)}
        style={{
          position: 'fixed',
          bottom: '1rem',
          right: '1rem',
          zIndex: 99999,
        }}
      >
        {showDevTools ? 'Hide' : 'Show'} DevTools
      </button>

      {showDevTools && <ReactQueryDevtools initialIsOpen={true} />}
    </QueryClientProvider>
  )
}

/**
 * DevTools Features (what you can do):
 *
 * 1. View all queries: See queryKey, status, data, error
 * 2. Inspect cache: View cached data for each query
 * 3. Manual refetch: Force refetch any query
 * 4. View mutations: See in-flight and completed mutations
 * 5. Query invalidation: Manually invalidate queries
 * 6. Explorer mode: Navigate query hierarchy
 * 7. Time travel: See query state over time
 * 8. Export state: Download current cache for debugging
 *
 * DevTools Panel Sections:
 * - Queries: All active/cached queries
 * - Mutations: Recent mutations
 * - Query Cache: Full cache state
 * - Mutation Cache: Mutation history
 * - Settings: DevTools configuration
 */

/**
 * Debugging with DevTools
 */

// Example: Check if query is being cached correctly
function DebugQueryCaching() {
  const { data, dataUpdatedAt, isFetching } = useQuery({
    queryKey: ['todos'],
    queryFn: fetchTodos,
  })

  return (
    <div>
      <p>Last updated: {new Date(dataUpdatedAt).toLocaleTimeString()}</p>
      <p>Is fetching: {isFetching ? 'Yes' : 'No'}</p>
      {/* Open DevTools to see:
          - Query status (fresh, fetching, stale)
          - Cache data
          - Refetch behavior
      */}
    </div>
  )
}

// Example: Debug why query keeps refetching
function DebugRefetchingIssue() {
  const { data, isFetching, isRefetching } = useQuery({
    queryKey: ['users'],
    queryFn: fetchUsers,
    // Check in DevTools if these settings are correct:
    staleTime: 0, // ❌ Data always stale, will refetch frequently
    refetchOnWindowFocus: true, // ❌ Refetches on every focus
    refetchOnMount: true, // ❌ Refetches on every mount
  })

  // DevTools will show you:
  // - How many times query refetched
  // - When it refetched (mount, focus, reconnect)
  // - Current staleTime and gcTime settings

  return <div>Fetching: {isFetching ? 'Yes' : 'No'}</div>
}

/**
 * Production DevTools (optional, separate package)
 *
 * For debugging production issues remotely
 * npm install @tanstack/react-query-devtools-production
 */
import { ReactQueryDevtools as ReactQueryDevtoolsProd } from '@tanstack/react-query-devtools-production'

function AppWithProductionDevTools() {
  const [showDevTools, setShowDevTools] = useState(false)

  useEffect(() => {
    // Load production devtools on demand
    // Only when user presses keyboard shortcut or secret URL
    if (showDevTools) {
      import('@tanstack/react-query-devtools-production').then((module) => {
        // Module loaded
      })
    }
  }, [showDevTools])

  return (
    <QueryClientProvider client={queryClient}>
      <App />
      {showDevTools && <ReactQueryDevtoolsProd />}
    </QueryClientProvider>
  )
}

/**
 * Keyboard Shortcuts (DIY)
 *
 * Add custom keyboard shortcut to toggle DevTools
 */
function AppWithKeyboardShortcut() {
  const [showDevTools, setShowDevTools] = useState(false)

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Ctrl/Cmd + Shift + D
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'd') {
        e.preventDefault()
        setShowDevTools((prev) => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyPress)
    return () => window.removeEventListener('keydown', handleKeyPress)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <App />
      {showDevTools && <ReactQueryDevtools />}
    </QueryClientProvider>
  )
}

/**
 * Best Practices:
 *
 * ✅ Keep DevTools in code (tree-shaken in production)
 * ✅ Start with initialIsOpen={false} to avoid distraction
 * ✅ Use DevTools to debug cache issues
 * ✅ Check DevTools when queries refetch unexpectedly
 * ✅ Export state for bug reports
 *
 * ❌ Don't ship production devtools without authentication
 * ❌ Don't rely on DevTools for production monitoring
 * ❌ Don't expose sensitive data in cache (use select to filter)
 *
 * Performance:
 * - DevTools have minimal performance impact in dev
 * - Completely removed in production builds
 * - No runtime overhead when not open
 */
