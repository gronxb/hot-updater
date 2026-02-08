// src/hooks/useTodos.ts
import { useQuery, queryOptions } from '@tanstack/react-query'

/**
 * Type definitions
 */
export type Todo = {
  id: number
  title: string
  completed: boolean
  userId: number
}

/**
 * API function - keeps network logic separate
 */
async function fetchTodos(): Promise<Todo[]> {
  const response = await fetch('https://jsonplaceholder.typicode.com/todos')

  if (!response.ok) {
    throw new Error(`Failed to fetch todos: ${response.statusText}`)
  }

  return response.json()
}

/**
 * Query options factory (v5 best practice)
 *
 * Benefits:
 * - Reusable across useQuery, useSuspenseQuery, prefetchQuery
 * - Perfect type inference
 * - Single source of truth for queryKey and queryFn
 */
export const todosQueryOptions = queryOptions({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  staleTime: 1000 * 60, // 1 minute
})

/**
 * Custom hook - encapsulates query logic
 *
 * Usage in component:
 * const { data, isPending, isError, error } = useTodos()
 */
export function useTodos() {
  return useQuery(todosQueryOptions)
}

/**
 * Fetch single todo by ID
 */
async function fetchTodoById(id: number): Promise<Todo> {
  const response = await fetch(
    `https://jsonplaceholder.typicode.com/todos/${id}`
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch todo ${id}: ${response.statusText}`)
  }

  return response.json()
}

/**
 * Custom hook for fetching single todo
 *
 * Usage:
 * const { data: todo } = useTodo(1)
 */
export function useTodo(id: number) {
  return useQuery({
    queryKey: ['todos', id],
    queryFn: () => fetchTodoById(id),
    enabled: !!id, // Only fetch if id is truthy
  })
}

/**
 * Component usage example:
 */
export function TodoList() {
  const { data, isPending, isError, error, isFetching } = useTodos()

  if (isPending) {
    return <div>Loading todos...</div>
  }

  if (isError) {
    return <div>Error: {error.message}</div>
  }

  return (
    <div>
      <h1>Todos {isFetching && '(Refetching...)'}</h1>
      <ul>
        {data.map((todo) => (
          <li key={todo.id}>
            <input type="checkbox" checked={todo.completed} readOnly />
            {todo.title}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Key states explained:
 *
 * - isPending: No data yet (initial fetch)
 * - isLoading: isPending && isFetching (loading for first time)
 * - isFetching: Any background fetch in progress
 * - isError: Query failed
 * - isSuccess: Query succeeded and data is available
 * - data: The fetched data (undefined while isPending)
 * - error: Error object if query failed
 */
