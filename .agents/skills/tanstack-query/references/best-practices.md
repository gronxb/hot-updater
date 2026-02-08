# TanStack Query Best Practices

**Performance, caching strategies, and common patterns**

---

## 1. Avoid Request Waterfalls

### ❌ Bad: Sequential Dependencies

```tsx
function BadUserProfile({ userId }) {
  const { data: user } = useQuery({
    queryKey: ['users', userId],
    queryFn: () => fetchUser(userId),
  })

  // Waits for user ⏳
  const { data: posts } = useQuery({
    queryKey: ['posts', user?.id],
    queryFn: () => fetchPosts(user!.id),
    enabled: !!user,
  })

  // Waits for posts ⏳⏳
  const { data: comments } = useQuery({
    queryKey: ['comments', posts?.[0]?.id],
    queryFn: () => fetchComments(posts![0].id),
    enabled: !!posts && posts.length > 0,
  })
}
```

### ✅ Good: Parallel Queries

```tsx
function GoodUserProfile({ userId }) {
  // All run in parallel 🚀
  const { data: user } = useQuery({
    queryKey: ['users', userId],
    queryFn: () => fetchUser(userId),
  })

  const { data: posts } = useQuery({
    queryKey: ['posts', userId], // Use userId, not user.id
    queryFn: () => fetchPosts(userId),
  })

  const { data: comments } = useQuery({
    queryKey: ['comments', userId],
    queryFn: () => fetchUserComments(userId),
  })
}
```

---

## 2. Query Key Strategy

### Hierarchical Structure

```tsx
// Global
['todos'] // All todos
['todos', { status: 'done' }] // Filtered todos
['todos', 123] // Single todo

// Invalidation hierarchy
queryClient.invalidateQueries({ queryKey: ['todos'] }) // Invalidates ALL todos
queryClient.invalidateQueries({ queryKey: ['todos', { status: 'done' }] }) // Only filtered
```

### Best Practices

```tsx
// ✅ Good: Stable, serializable keys
['users', userId, { sort: 'name', filter: 'active' }]

// ❌ Bad: Functions in keys (not serializable)
['users', () => userId]

// ❌ Bad: Changing order
['users', { filter: 'active', sort: 'name' }] // Different key!

// ✅ Good: Consistent ordering
const userFilters = { filter: 'active', sort: 'name' }
```

---

## 3. Caching Configuration

### staleTime vs gcTime

```tsx
/**
 * staleTime: How long data is "fresh" (won't refetch)
 * gcTime: How long unused data stays in cache
 */

// Real-time data
staleTime: 0 // Always stale, refetch frequently
gcTime: 1000 * 60 * 5 // 5 min in cache

// Stable data
staleTime: 1000 * 60 * 60 // 1 hour fresh
gcTime: 1000 * 60 * 60 * 24 // 24 hours in cache

// Static data
staleTime: Infinity // Never stale
gcTime: Infinity // Never garbage collect
```

### Per-Query vs Global

```tsx
// Global defaults
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 60,
    },
  },
})

// Override per query
useQuery({
  queryKey: ['stock-price'],
  queryFn: fetchStockPrice,
  staleTime: 0, // Override: always stale
  refetchInterval: 1000 * 30, // Refetch every 30s
})
```

---

## 4. Use queryOptions Factory

```tsx
// ✅ Best practice: Reusable options
export const todosQueryOptions = queryOptions({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  staleTime: 1000 * 60,
})

// Use everywhere
useQuery(todosQueryOptions)
useSuspenseQuery(todosQueryOptions)
queryClient.prefetchQuery(todosQueryOptions)

// ❌ Bad: Duplicated configuration
useQuery({ queryKey: ['todos'], queryFn: fetchTodos })
useSuspenseQuery({ queryKey: ['todos'], queryFn: fetchTodos })
```

---

## 5. Data Transformations

### select Option

```tsx
// Only re-render when count changes
function TodoCount() {
  const { data: count } = useQuery({
    queryKey: ['todos'],
    queryFn: fetchTodos,
    select: (data) => data.length, // Transform
  })
}

// Cache full data, component gets filtered
function CompletedTodos() {
  const { data } = useQuery({
    queryKey: ['todos'],
    queryFn: fetchTodos,
    select: (data) => data.filter(todo => todo.completed),
  })
}
```

---

## 6. Prefetching

```tsx
function TodoList() {
  const queryClient = useQueryClient()
  const { data: todos } = useTodos()

  const prefetch = (id: number) => {
    queryClient.prefetchQuery({
      queryKey: ['todos', id],
      queryFn: () => fetchTodo(id),
      staleTime: 1000 * 60 * 5,
    })
  }

  return (
    <ul>
      {todos.map(todo => (
        <li key={todo.id} onMouseEnter={() => prefetch(todo.id)}>
          <Link to={`/todos/${todo.id}`}>{todo.title}</Link>
        </li>
      ))}
    </ul>
  )
}
```

---

## 7. Optimistic Updates

Use for:
- ✅ Low-risk actions (toggle, like)
- ✅ Frequent actions (better UX)

Avoid for:
- ❌ Critical operations (payments)
- ❌ Complex validations

```tsx
useMutation({
  mutationFn: updateTodo,
  onMutate: async (newTodo) => {
    await queryClient.cancelQueries({ queryKey: ['todos'] })
    const previous = queryClient.getQueryData(['todos'])
    queryClient.setQueryData(['todos'], (old) => [...old, newTodo])
    return { previous }
  },
  onError: (err, newTodo, context) => {
    queryClient.setQueryData(['todos'], context.previous)
  },
  onSettled: () => {
    queryClient.invalidateQueries({ queryKey: ['todos'] })
  },
})
```

---

## 8. Error Handling Strategy

### Local vs Global

```tsx
// Local: Handle in component
const { data, error, isError } = useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
})

if (isError) return <div>Error: {error.message}</div>

// Global: Error boundaries
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  throwOnError: true, // Throw to boundary
})

// Conditional: Mix both
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  throwOnError: (error) => error.status >= 500, // Only 5xx to boundary
})
```

---

## 9. Server State vs Client State

```tsx
// ❌ Don't use TanStack Query for client state
const { data: isModalOpen } = useMutation(...)

// ✅ Use useState for client state
const [isModalOpen, setIsModalOpen] = useState(false)

// ✅ Use TanStack Query for server state only
const { data: todos } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos })
```

---

## 10. Performance Monitoring

### Use DevTools

- Check refetch frequency
- Verify cache hits
- Monitor query states
- Export state for debugging

### Key Metrics

- Time to first data
- Cache hit rate
- Refetch frequency
- Network requests count
