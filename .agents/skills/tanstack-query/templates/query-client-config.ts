// src/lib/query-client.ts
import { QueryClient } from '@tanstack/react-query'

/**
 * QueryClient configuration for TanStack Query v5
 *
 * Key settings:
 * - staleTime: How long data is fresh (won't refetch)
 * - gcTime: How long inactive data stays in cache (garbage collection time)
 * - retry: Number of retry attempts on failure
 * - refetchOnWindowFocus: Refetch when window regains focus
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data is fresh for 5 minutes (won't refetch during this time)
      staleTime: 1000 * 60 * 5,

      // Inactive data stays in cache for 1 hour before garbage collection
      gcTime: 1000 * 60 * 60,

      // Retry failed requests with smart logic
      retry: (failureCount, error) => {
        // Don't retry on 404s
        if (error instanceof Response && error.status === 404) {
          return false
        }
        // Retry up to 3 times for other errors
        return failureCount < 3
      },

      // Don't refetch on window focus (can be annoying during dev)
      // Set to true for real-time data (stock prices, notifications)
      refetchOnWindowFocus: false,

      // Refetch when network reconnects
      refetchOnReconnect: true,

      // Refetch on component mount if data is stale
      refetchOnMount: true,
    },
    mutations: {
      // Don't retry mutations by default (usually not wanted)
      retry: 0,

      // Global mutation error handler (optional)
      onError: (error) => {
        console.error('Mutation error:', error)
        // Add global error handling here (toast, alert, etc.)
      },
    },
  },
})

/**
 * Adjust these settings based on your needs:
 *
 * For real-time data (stock prices, notifications):
 * - staleTime: 0 (always stale, refetch frequently)
 * - refetchOnWindowFocus: true
 * - refetchInterval: 1000 * 30 (refetch every 30s)
 *
 * For static data (user settings, app config):
 * - staleTime: Infinity (never stale)
 * - refetchOnWindowFocus: false
 * - refetchOnMount: false
 *
 * For moderate data (todos, posts):
 * - staleTime: 1000 * 60 * 5 (5 minutes)
 * - refetchOnWindowFocus: false
 * - refetchOnMount: true
 */
