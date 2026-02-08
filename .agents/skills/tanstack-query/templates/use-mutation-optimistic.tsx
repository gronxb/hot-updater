// src/hooks/useOptimisticTodoMutations.ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Todo } from './useTodos'

/**
 * Optimistic Update Pattern
 *
 * Updates UI immediately before server responds, then:
 * - On success: Keep the optimistic update
 * - On error: Roll back to previous state
 *
 * Best for:
 * - Low-risk actions (toggle, like, favorite)
 * - Frequently used actions (better UX with instant feedback)
 *
 * Avoid for:
 * - Critical operations (payments, account changes)
 * - Complex validations (server might reject)
 */

type AddTodoInput = {
  title: string
}

type UpdateTodoInput = {
  id: number
  completed: boolean
}

/**
 * Optimistic Add Todo
 *
 * Immediately shows new todo in UI, then confirms with server
 */
export function useOptimisticAddTodo() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (newTodo: AddTodoInput) => {
      const response = await fetch(
        'https://jsonplaceholder.typicode.com/todos',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...newTodo, userId: 1, completed: false }),
        }
      )

      if (!response.ok) throw new Error('Failed to add todo')
      return response.json()
    },

    // Before mutation runs
    onMutate: async (newTodo) => {
      // Cancel outgoing refetches (so they don't overwrite our optimistic update)
      await queryClient.cancelQueries({ queryKey: ['todos'] })

      // Snapshot current value
      const previousTodos = queryClient.getQueryData<Todo[]>(['todos'])

      // Optimistically update cache
      queryClient.setQueryData<Todo[]>(['todos'], (old = []) => [
        ...old,
        {
          id: Date.now(), // Temporary ID
          ...newTodo,
          completed: false,
          userId: 1,
        },
      ])

      // Return context with snapshot (used for rollback)
      return { previousTodos }
    },

    // If mutation fails, rollback using context
    onError: (err, newTodo, context) => {
      console.error('Failed to add todo:', err)

      // Restore previous state
      if (context?.previousTodos) {
        queryClient.setQueryData(['todos'], context.previousTodos)
      }
    },

    // Always refetch after mutation settles (success or error)
    // Ensures cache matches server state
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['todos'] })
    },
  })
}

/**
 * Optimistic Update Todo
 *
 * Immediately toggles todo in UI, confirms with server
 */
export function useOptimisticUpdateTodo() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, completed }: UpdateTodoInput) => {
      const response = await fetch(
        `https://jsonplaceholder.typicode.com/todos/${id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ completed }),
        }
      )

      if (!response.ok) throw new Error('Failed to update todo')
      return response.json()
    },

    onMutate: async ({ id, completed }) => {
      await queryClient.cancelQueries({ queryKey: ['todos'] })

      // Snapshot
      const previousTodos = queryClient.getQueryData<Todo[]>(['todos'])

      // Optimistic update
      queryClient.setQueryData<Todo[]>(['todos'], (old = []) =>
        old.map((todo) =>
          todo.id === id ? { ...todo, completed } : todo
        )
      )

      return { previousTodos }
    },

    onError: (err, variables, context) => {
      console.error('Failed to update todo:', err)
      if (context?.previousTodos) {
        queryClient.setQueryData(['todos'], context.previousTodos)
      }
    },

    onSettled: (data, error, variables) => {
      queryClient.invalidateQueries({ queryKey: ['todos'] })
      queryClient.invalidateQueries({ queryKey: ['todos', variables.id] })
    },
  })
}

/**
 * Optimistic Delete Todo
 *
 * Immediately removes todo from UI, confirms with server
 */
export function useOptimisticDeleteTodo() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: number) => {
      const response = await fetch(
        `https://jsonplaceholder.typicode.com/todos/${id}`,
        {
          method: 'DELETE',
        }
      )

      if (!response.ok) throw new Error('Failed to delete todo')
    },

    onMutate: async (deletedId) => {
      await queryClient.cancelQueries({ queryKey: ['todos'] })

      const previousTodos = queryClient.getQueryData<Todo[]>(['todos'])

      // Optimistically remove from cache
      queryClient.setQueryData<Todo[]>(['todos'], (old = []) =>
        old.filter((todo) => todo.id !== deletedId)
      )

      return { previousTodos }
    },

    onError: (err, variables, context) => {
      console.error('Failed to delete todo:', err)
      if (context?.previousTodos) {
        queryClient.setQueryData(['todos'], context.previousTodos)
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['todos'] })
    },
  })
}

/**
 * Component usage example:
 */
export function OptimisticTodoItem({ todo }: { todo: Todo }) {
  const { mutate: updateTodo, isPending: isUpdating } = useOptimisticUpdateTodo()
  const { mutate: deleteTodo, isPending: isDeleting } = useOptimisticDeleteTodo()

  return (
    <li style={{ opacity: isUpdating || isDeleting ? 0.5 : 1 }}>
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={(e) => updateTodo({ id: todo.id, completed: e.target.checked })}
        disabled={isUpdating || isDeleting}
      />
      <span>{todo.title}</span>
      <button
        onClick={() => deleteTodo(todo.id)}
        disabled={isUpdating || isDeleting}
      >
        {isDeleting ? 'Deleting...' : 'Delete'}
      </button>
    </li>
  )
}

/**
 * Key patterns:
 *
 * 1. onMutate: Cancel queries, snapshot state, update cache optimistically
 * 2. onError: Rollback using context
 * 3. onSettled: Refetch to ensure cache matches server (always runs)
 * 4. cancelQueries: Prevent race conditions
 * 5. Return context from onMutate: Available in onError and onSettled
 *
 * Trade-offs:
 * ✅ Instant UI feedback (feels faster)
 * ✅ Better UX for common actions
 * ❌ More complex code
 * ❌ Risk of inconsistent state if not handled correctly
 * ❌ Not suitable for critical operations
 */
