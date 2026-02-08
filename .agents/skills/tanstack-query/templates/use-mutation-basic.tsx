// src/hooks/useTodoMutations.ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Todo } from './useTodos'

/**
 * Input types for mutations
 */
type AddTodoInput = {
  title: string
  completed?: boolean
}

type UpdateTodoInput = {
  id: number
  title?: string
  completed?: boolean
}

/**
 * API functions
 */
async function addTodo(newTodo: AddTodoInput): Promise<Todo> {
  const response = await fetch('https://jsonplaceholder.typicode.com/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...newTodo, userId: 1 }),
  })

  if (!response.ok) {
    throw new Error(`Failed to add todo: ${response.statusText}`)
  }

  return response.json()
}

async function updateTodo({ id, ...updates }: UpdateTodoInput): Promise<Todo> {
  const response = await fetch(
    `https://jsonplaceholder.typicode.com/todos/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }
  )

  if (!response.ok) {
    throw new Error(`Failed to update todo: ${response.statusText}`)
  }

  return response.json()
}

async function deleteTodo(id: number): Promise<void> {
  const response = await fetch(
    `https://jsonplaceholder.typicode.com/todos/${id}`,
    {
      method: 'DELETE',
    }
  )

  if (!response.ok) {
    throw new Error(`Failed to delete todo: ${response.statusText}`)
  }
}

/**
 * Hook: Add new todo
 *
 * Usage:
 * const { mutate, isPending, isError, error } = useAddTodo()
 * mutate({ title: 'New todo' })
 */
export function useAddTodo() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: addTodo,

    // Runs on successful mutation
    onSuccess: () => {
      // Invalidate todos query to trigger refetch
      queryClient.invalidateQueries({ queryKey: ['todos'] })
    },

    // Runs on error
    onError: (error) => {
      console.error('Failed to add todo:', error)
      // Add user notification here (toast, alert, etc.)
    },

    // Runs regardless of success or error
    onSettled: () => {
      console.log('Add todo mutation completed')
    },
  })
}

/**
 * Hook: Update existing todo
 *
 * Usage:
 * const { mutate } = useUpdateTodo()
 * mutate({ id: 1, completed: true })
 */
export function useUpdateTodo() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: updateTodo,

    onSuccess: (updatedTodo) => {
      // Update specific todo in cache
      queryClient.setQueryData<Todo>(['todos', updatedTodo.id], updatedTodo)

      // Invalidate list to refetch
      queryClient.invalidateQueries({ queryKey: ['todos'] })
    },
  })
}

/**
 * Hook: Delete todo
 *
 * Usage:
 * const { mutate } = useDeleteTodo()
 * mutate(todoId)
 */
export function useDeleteTodo() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: deleteTodo,

    onSuccess: (_, deletedId) => {
      // Remove from list cache
      queryClient.setQueryData<Todo[]>(['todos'], (old = []) =>
        old.filter((todo) => todo.id !== deletedId)
      )

      // Remove individual todo cache
      queryClient.removeQueries({ queryKey: ['todos', deletedId] })
    },
  })
}

/**
 * Component usage example:
 */
export function AddTodoForm() {
  const { mutate, isPending, isError, error } = useAddTodo()

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const title = formData.get('title') as string

    mutate(
      { title },
      {
        // Optional per-mutation callbacks
        onSuccess: () => {
          e.currentTarget.reset()
          console.log('Todo added successfully!')
        },
      }
    )
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        name="title"
        placeholder="New todo..."
        required
        disabled={isPending}
      />
      <button type="submit" disabled={isPending}>
        {isPending ? 'Adding...' : 'Add Todo'}
      </button>
      {isError && <div>Error: {error.message}</div>}
    </form>
  )
}

/**
 * Key concepts:
 *
 * 1. Mutations don't cache data (unlike queries)
 * 2. Use onSuccess to invalidate related queries
 * 3. queryClient.invalidateQueries() marks queries as stale and refetches
 * 4. queryClient.setQueryData() directly updates cache (optimistic update)
 * 5. queryClient.removeQueries() removes specific query from cache
 *
 * Mutation states:
 * - isPending: Mutation in progress
 * - isError: Mutation failed
 * - isSuccess: Mutation succeeded
 * - data: Returned data from mutationFn
 * - error: Error if mutation failed
 */
