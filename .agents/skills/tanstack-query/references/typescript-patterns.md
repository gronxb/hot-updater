# TypeScript Patterns for TanStack Query

**Type-safe query and mutation patterns**

---

## 1. Basic Type Inference

```tsx
type Todo = {
  id: number
  title: string
  completed: boolean
}

// ✅ Automatic type inference
const { data } = useQuery({
  queryKey: ['todos'],
  queryFn: async (): Promise<Todo[]> => {
    const response = await fetch('/api/todos')
    return response.json()
  },
})
// data is typed as Todo[] | undefined
```

---

## 2. Generic Query Hook

```tsx
function useEntity<T>(
  endpoint: string,
  id: number
) {
  return useQuery({
    queryKey: [endpoint, id],
    queryFn: async (): Promise<T> => {
      const response = await fetch(`/api/${endpoint}/${id}`)
      return response.json()
    },
  })
}

// Usage
const { data } = useEntity<User>('users', 1)
// data: User | undefined
```

---

## 3. queryOptions with Type Safety

```tsx
export const todosQueryOptions = queryOptions({
  queryKey: ['todos'],
  queryFn: async (): Promise<Todo[]> => {
    const response = await fetch('/api/todos')
    return response.json()
  },
  staleTime: 1000 * 60,
})

// Perfect type inference everywhere
useQuery(todosQueryOptions)
useSuspenseQuery(todosQueryOptions)
queryClient.prefetchQuery(todosQueryOptions)
```

---

## 4. Mutation with Types

```tsx
type CreateTodoInput = {
  title: string
}

type CreateTodoResponse = Todo

const { mutate } = useMutation<
  CreateTodoResponse, // TData
  Error, // TError
  CreateTodoInput, // TVariables
  { previous?: Todo[] } // TContext
>({
  mutationFn: async (input) => {
    const response = await fetch('/api/todos', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return response.json()
  },
})

// Type-safe mutation
mutate({ title: 'New todo' })
```

---

## 5. Custom Error Types

```tsx
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string
  ) {
    super(message)
  }
}

const { data, error } = useQuery<Todo[], ApiError>({
  queryKey: ['todos'],
  queryFn: async () => {
    const response = await fetch('/api/todos')
    if (!response.ok) {
      throw new ApiError(
        'Failed to fetch',
        response.status,
        'FETCH_ERROR'
      )
    }
    return response.json()
  },
})

if (error) {
  // error.status and error.code are typed
}
```

---

## 6. Zod Schema Validation

```tsx
import { z } from 'zod'

const TodoSchema = z.object({
  id: z.number(),
  title: z.string(),
  completed: z.boolean(),
})

type Todo = z.infer<typeof TodoSchema>

const { data } = useQuery({
  queryKey: ['todos'],
  queryFn: async () => {
    const response = await fetch('/api/todos')
    const json = await response.json()
    return TodoSchema.array().parse(json) // Runtime + compile time safety
  },
})
```

---

## 7. Discriminated Union for Status

```tsx
type QueryState<T> =
  | { status: 'pending'; data: undefined; error: null }
  | { status: 'error'; data: undefined; error: Error }
  | { status: 'success'; data: T; error: null }

function useTypedQuery<T>(
  queryKey: string[],
  queryFn: () => Promise<T>
): QueryState<T> {
  const { data, status, error } = useQuery({ queryKey, queryFn })

  return {
    status,
    data: data as any,
    error: error as any,
  }
}

// Usage with exhaustive checking
const result = useTypedQuery(['todos'], fetchTodos)

switch (result.status) {
  case 'pending':
    return <Loading />
  case 'error':
    return <Error error={result.error} /> // error is typed
  case 'success':
    return <TodoList todos={result.data} /> // data is typed
}
```

---

## 8. Type-Safe Query Keys

```tsx
// Define all query keys in one place
const queryKeys = {
  todos: {
    all: ['todos'] as const,
    lists: () => [...queryKeys.todos.all, 'list'] as const,
    list: (filters: TodoFilters) =>
      [...queryKeys.todos.lists(), filters] as const,
    details: () => [...queryKeys.todos.all, 'detail'] as const,
    detail: (id: number) =>
      [...queryKeys.todos.details(), id] as const,
  },
}

// Usage
useQuery({
  queryKey: queryKeys.todos.detail(1),
  queryFn: () => fetchTodo(1),
})

queryClient.invalidateQueries({
  queryKey: queryKeys.todos.all
})
```

---

## 9. Utility Types

```tsx
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query'

// Extract query data type
type TodosQuery = UseQueryResult<Todo[]>
type TodoData = TodosQuery['data'] // Todo[] | undefined

// Extract mutation types
type AddTodoMutation = UseMutationResult<
  Todo,
  Error,
  CreateTodoInput
>
```

---

## 10. Strict Null Checks

```tsx
const { data } = useQuery({
  queryKey: ['todo', id],
  queryFn: () => fetchTodo(id),
})

// ❌ TypeScript error if strictNullChecks enabled
const title = data.title

// ✅ Proper null handling
const title = data?.title ?? 'No title'

// ✅ Type guard
if (data) {
  const title = data.title // data is Todo, not undefined
}
```

---

## 11. SuspenseQuery Types

```tsx
const { data } = useSuspenseQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
})

// data is ALWAYS Todo[], never undefined
// No need for undefined checks with suspense
data.map(todo => todo.title) // ✅ Safe
```

---

## Best Practices

✅ Always type queryFn return value
✅ Use const assertions for query keys
✅ Leverage queryOptions for reusability
✅ Use Zod for runtime + compile time validation
✅ Enable strict null checks
✅ Create type-safe query key factories
✅ Use custom error types for better error handling
