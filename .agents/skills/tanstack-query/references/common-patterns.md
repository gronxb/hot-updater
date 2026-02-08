# Common TanStack Query Patterns

**Reusable patterns for real-world applications**

---

## Pattern 1: Dependent Queries

Query B depends on data from Query A:

```tsx
function UserPosts({ userId }) {
  const { data: user } = useQuery({
    queryKey: ['users', userId],
    queryFn: () => fetchUser(userId),
  })

  const { data: posts } = useQuery({
    queryKey: ['users', userId, 'posts'],
    queryFn: () => fetchUserPosts(userId),
    enabled: !!user, // Wait for user
  })
}
```

---

## Pattern 2: Parallel Queries with useQueries

Fetch multiple resources in parallel:

```tsx
function TodoDetails({ ids }) {
  const results = useQueries({
    queries: ids.map(id => ({
      queryKey: ['todos', id],
      queryFn: () => fetchTodo(id),
    })),
  })

  const isLoading = results.some(r => r.isPending)
  const data = results.map(r => r.data)
}
```

---

## Pattern 3: Paginated Queries with placeholderData

Keep previous data while fetching next page:

```tsx
import { keepPreviousData } from '@tanstack/react-query'

function PaginatedTodos() {
  const [page, setPage] = useState(0)

  const { data } = useQuery({
    queryKey: ['todos', page],
    queryFn: () => fetchTodos(page),
    placeholderData: keepPreviousData, // Keep old data while loading
  })
}
```

---

## Pattern 4: Infinite Scroll

Auto-load more data on scroll:

```tsx
function InfiniteList() {
  const { data, fetchNextPage, hasNextPage } = useInfiniteQuery({
    queryKey: ['items'],
    queryFn: ({ pageParam }) => fetchItems(pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  })

  // Intersection Observer for auto-loading
  const ref = useRef()
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && hasNextPage && fetchNextPage()
    )
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [fetchNextPage, hasNextPage])

  return (
    <>
      {data.pages.map(page => page.data.map(item => <div>{item}</div>))}
      <div ref={ref}>Loading...</div>
    </>
  )
}
```

---

## Pattern 5: Optimistic Updates

Instant UI feedback:

```tsx
function useOptimisticToggle() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: updateTodo,
    onMutate: async (updated) => {
      await queryClient.cancelQueries({ queryKey: ['todos'] })
      const previous = queryClient.getQueryData(['todos'])

      queryClient.setQueryData(['todos'], (old) =>
        old.map(todo => todo.id === updated.id ? updated : todo)
      )

      return { previous }
    },
    onError: (err, vars, context) => {
      queryClient.setQueryData(['todos'], context.previous)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['todos'] })
    },
  })
}
```

---

## Pattern 6: Prefetching on Hover

Load data before user clicks:

```tsx
function TodoList() {
  const queryClient = useQueryClient()

  const prefetch = (id) => {
    queryClient.prefetchQuery({
      queryKey: ['todos', id],
      queryFn: () => fetchTodo(id),
    })
  }

  return (
    <ul>
      {todos.map(todo => (
        <li onMouseEnter={() => prefetch(todo.id)}>
          <Link to={`/todos/${todo.id}`}>{todo.title}</Link>
        </li>
      ))}
    </ul>
  )
}
```

---

## Pattern 7: Search/Debounce

Debounced search with automatic cancellation:

```tsx
import { useState, useDeferredValue } from 'react'

function Search() {
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)

  const { data } = useQuery({
    queryKey: ['search', deferredSearch],
    queryFn: ({ signal }) =>
      fetch(`/api/search?q=${deferredSearch}`, { signal }).then(r => r.json()),
    enabled: deferredSearch.length >= 2,
  })
}
```

---

## Pattern 8: Polling/Refetch Interval

Auto-refetch every N seconds:

```tsx
const { data } = useQuery({
  queryKey: ['stock-price'],
  queryFn: fetchStockPrice,
  refetchInterval: 1000 * 30, // Every 30 seconds
  refetchIntervalInBackground: true, // Even when tab inactive
})
```

---

## Pattern 9: Conditional Fetching

Only fetch when needed:

```tsx
const { data } = useQuery({
  queryKey: ['user', userId],
  queryFn: () => fetchUser(userId),
  enabled: !!userId && isAuthenticated,
})
```

---

## Pattern 10: Initial Data from Cache

Use cached data as initial value:

```tsx
const { data: todo } = useQuery({
  queryKey: ['todos', id],
  queryFn: () => fetchTodo(id),
  initialData: () => {
    return queryClient
      .getQueryData(['todos'])
      ?.find(t => t.id === id)
  },
})
```

---

## Pattern 11: Mutation with Multiple Invalidations

Update multiple related queries:

```tsx
useMutation({
  mutationFn: updateTodo,
  onSuccess: (updated) => {
    queryClient.setQueryData(['todos', updated.id], updated)
    queryClient.invalidateQueries({ queryKey: ['todos'] })
    queryClient.invalidateQueries({ queryKey: ['stats'] })
    queryClient.invalidateQueries({ queryKey: ['users', updated.userId] })
  },
})
```

---

## Pattern 12: Global Error Handler

Centralized error handling:

```tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      onError: (error) => {
        toast.error(error.message)
        logToSentry(error)
      },
    },
    mutations: {
      onError: (error) => {
        toast.error('Action failed')
        logToSentry(error)
      },
    },
  },
})
```
