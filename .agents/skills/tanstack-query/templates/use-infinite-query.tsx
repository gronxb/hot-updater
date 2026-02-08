// src/hooks/useInfiniteTodos.ts
import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import type { Todo } from './useTodos'

/**
 * Paginated response type
 */
type TodosPage = {
  data: Todo[]
  nextCursor: number | null
  previousCursor: number | null
}

/**
 * Fetch paginated todos
 *
 * In real API: cursor would be offset, page number, or last item ID
 */
async function fetchTodosPage({ pageParam }: { pageParam: number }): Promise<TodosPage> {
  const limit = 20
  const start = pageParam * limit
  const end = start + limit

  const response = await fetch(
    `https://jsonplaceholder.typicode.com/todos?_start=${start}&_limit=${limit}`
  )

  if (!response.ok) {
    throw new Error('Failed to fetch todos')
  }

  const data: Todo[] = await response.json()

  return {
    data,
    nextCursor: data.length === limit ? pageParam + 1 : null,
    previousCursor: pageParam > 0 ? pageParam - 1 : null,
  }
}

/**
 * Infinite query hook
 *
 * Usage:
 * const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteTodos()
 */
export function useInfiniteTodos() {
  return useInfiniteQuery({
    queryKey: ['todos', 'infinite'],
    queryFn: fetchTodosPage,

    // v5 REQUIRES initialPageParam (was optional in v4)
    initialPageParam: 0,

    // Determine if there are more pages
    getNextPageParam: (lastPage) => lastPage.nextCursor,

    // Optional: Determine if there are previous pages (bidirectional)
    getPreviousPageParam: (firstPage) => firstPage.previousCursor,

    // How many pages to keep in memory (default: Infinity)
    maxPages: undefined,
  })
}

/**
 * Component with manual "Load More" button
 */
export function InfiniteTodosManual() {
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    isError,
    error,
  } = useInfiniteTodos()

  if (isPending) return <div>Loading...</div>
  if (isError) return <div>Error: {error.message}</div>

  return (
    <div>
      <h1>Infinite Todos (Manual)</h1>

      {/* Render all pages */}
      {data.pages.map((page, i) => (
        <div key={i}>
          <h2>Page {i + 1}</h2>
          <ul>
            {page.data.map((todo) => (
              <li key={todo.id}>
                <input type="checkbox" checked={todo.completed} readOnly />
                {todo.title}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {/* Load more button */}
      <button
        onClick={() => fetchNextPage()}
        disabled={!hasNextPage || isFetchingNextPage}
      >
        {isFetchingNextPage
          ? 'Loading more...'
          : hasNextPage
          ? 'Load More'
          : 'No more todos'}
      </button>
    </div>
  )
}

/**
 * Component with automatic infinite scroll
 * Uses Intersection Observer to detect when user scrolls to bottom
 */
export function InfiniteTodosAuto() {
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    isError,
    error,
  } = useInfiniteTodos()

  const loadMoreRef = useRef<HTMLDivElement>(null)

  // Intersection Observer for automatic loading
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        // When sentinel element is visible and there are more pages
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage()
        }
      },
      { threshold: 0.1 } // Trigger when 10% of element is visible
    )

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current)
    }

    return () => {
      observer.disconnect()
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  if (isPending) return <div>Loading...</div>
  if (isError) return <div>Error: {error.message}</div>

  return (
    <div>
      <h1>Infinite Todos (Auto)</h1>

      {/* Render all pages */}
      {data.pages.map((page, i) => (
        <div key={i}>
          {page.data.map((todo) => (
            <div key={todo.id}>
              <input type="checkbox" checked={todo.completed} readOnly />
              {todo.title}
            </div>
          ))}
        </div>
      ))}

      {/* Sentinel element - triggers loading when scrolled into view */}
      <div ref={loadMoreRef}>
        {isFetchingNextPage ? (
          <div>Loading more...</div>
        ) : hasNextPage ? (
          <div>Scroll to load more</div>
        ) : (
          <div>No more todos</div>
        )}
      </div>
    </div>
  )
}

/**
 * Key concepts:
 *
 * 1. data.pages: Array of all fetched pages
 * 2. fetchNextPage(): Loads next page
 * 3. hasNextPage: Boolean if more pages available
 * 4. isFetchingNextPage: Loading state for next page
 * 5. initialPageParam: Starting cursor (REQUIRED in v5)
 * 6. getNextPageParam: Function returning next cursor or null
 *
 * Access all data:
 * const allTodos = data.pages.flatMap(page => page.data)
 *
 * Bidirectional scrolling:
 * - Add getPreviousPageParam
 * - Use fetchPreviousPage() and hasPreviousPage
 *
 * Performance:
 * - Use maxPages to limit memory (e.g., maxPages: 10)
 * - Old pages are garbage collected automatically
 *
 * Common patterns:
 * - Manual: Load More button
 * - Auto: Intersection Observer
 * - Virtualized: react-window or react-virtual for huge lists
 */
