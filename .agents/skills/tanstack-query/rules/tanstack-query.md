---
paths: "**/*.tsx", "**/*.ts", "**/*query*.ts", "**/*hook*.ts"
---

# TanStack Query v5 Corrections

Claude's training may reference TanStack Query v4 patterns. This project uses **v5**.

## Object Syntax Required

```typescript
/* ❌ v4 array syntax (removed in v5) */
useQuery(['todos'], fetchTodos, { staleTime: 5000 })

/* ✅ v5 object syntax only */
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  staleTime: 5000
})
```

## Query Callbacks Removed

```typescript
/* ❌ v5 removed onSuccess/onError/onSettled from queries */
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  onSuccess: (data) => console.log(data), // Removed!
})

/* ✅ Use useEffect instead */
const { data } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos })
useEffect(() => {
  if (data) console.log(data)
}, [data])

/* Note: Mutations still support callbacks */
useMutation({
  mutationFn: addTodo,
  onSuccess: () => {}, // Still works!
})
```

## isPending vs isLoading

```typescript
/* ❌ isLoading meaning changed in v5 */
if (isLoading) return <Loading />

/* ✅ Use isPending for initial load */
const { data, isPending } = useQuery(...)
if (isPending) return <Loading />
// isPending = no data yet
// isLoading = isPending && isFetching
```

## cacheTime → gcTime

```typescript
/* ❌ Renamed in v5 */
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  cacheTime: 1000 * 60 * 60, // Error!
})

/* ✅ Use gcTime */
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  gcTime: 1000 * 60 * 60,
})
```

## keepPreviousData → placeholderData

```typescript
/* ❌ Removed in v5 */
useQuery({
  queryKey: ['todos', page],
  queryFn: () => fetchTodos(page),
  keepPreviousData: true, // Error!
})

/* ✅ Use placeholderData helper */
import { keepPreviousData } from '@tanstack/react-query'

useQuery({
  queryKey: ['todos', page],
  queryFn: () => fetchTodos(page),
  placeholderData: keepPreviousData,
})
```

## Infinite Queries: initialPageParam Required

```typescript
/* ❌ v4 used undefined as first pageParam */
useInfiniteQuery({
  queryKey: ['projects'],
  queryFn: ({ pageParam = 0 }) => fetchProjects(pageParam),
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})

/* ✅ v5 requires explicit initialPageParam */
useInfiniteQuery({
  queryKey: ['projects'],
  queryFn: ({ pageParam }) => fetchProjects(pageParam),
  initialPageParam: 0, // Required!
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})
```

## Quick Fixes

| If Claude suggests... | Use instead... |
|----------------------|----------------|
| `useQuery(['key'], fn, opts)` | `useQuery({ queryKey, queryFn, ...opts })` |
| `onSuccess` in useQuery | `useEffect` watching data |
| `cacheTime` | `gcTime` |
| `isLoading` for initial load | `isPending` |
| `keepPreviousData: true` | `placeholderData: keepPreviousData` |
| Missing `initialPageParam` | Add `initialPageParam: 0` (or appropriate value) |
| `useErrorBoundary` | `throwOnError` |
