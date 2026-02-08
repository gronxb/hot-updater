# Top TanStack Query Errors & Solutions

**Complete error reference with fixes**

---

## Error #1: Object Syntax Required

**Error Message**:
```
TypeError: useQuery is not a function
Property 'queryKey' does not exist on type...
```

**Why**:
v5 removed function overloads, only object syntax works

**Fix**:
```tsx
// ❌ v4 syntax
useQuery(['todos'], fetchTodos)

// ✅ v5 syntax
useQuery({ queryKey: ['todos'], queryFn: fetchTodos })
```

**Source**: [v5 Migration Guide](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#removed-overloads-in-favor-of-object-syntax)

---

## Error #2: Query Callbacks Not Working

**Error Message**:
```
Property 'onSuccess' does not exist on type 'UseQueryOptions'
```

**Why**:
`onSuccess`, `onError`, `onSettled` removed from queries (still work in mutations)

**Fix**:
```tsx
// ❌ v4
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  onSuccess: (data) => console.log(data)
})

// ✅ v5 - Use useEffect
const { data } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos })
useEffect(() => {
  if (data) console.log(data)
}, [data])
```

**Source**: [v5 Breaking Changes](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#callbacks-on-usequery-and-queryobserver-have-been-removed)

---

## Error #3: isLoading Always False

**Error Message**:
No error, but `isLoading` is false during initial fetch

**Why**:
v5 changed `isLoading` meaning: now `isPending && isFetching`

**Fix**:
```tsx
// ❌ v4
const { isLoading } = useQuery(...)
if (isLoading) return <Loading />

// ✅ v5
const { isPending } = useQuery(...)
if (isPending) return <Loading />
```

**Source**: [v5 Migration](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#isloading-and-isfetching-flags)

---

## Error #4: cacheTime Not Recognized

**Error Message**:
```
Property 'cacheTime' does not exist on type 'UseQueryOptions'
```

**Why**:
Renamed to `gcTime` (garbage collection time)

**Fix**:
```tsx
// ❌ v4
cacheTime: 1000 * 60 * 60

// ✅ v5
gcTime: 1000 * 60 * 60
```

**Source**: [v5 Migration](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#cachetime-has-been-replaced-by-gcTime)

---

## Error #5: useSuspenseQuery + enabled

**Error Message**:
```
Property 'enabled' does not exist on type 'UseSuspenseQueryOptions'
```

**Why**:
Suspense guarantees data is available, can't conditionally disable

**Fix**:
```tsx
// ❌ Wrong
useSuspenseQuery({
  queryKey: ['todo', id],
  queryFn: () => fetchTodo(id),
  enabled: !!id,
})

// ✅ Correct: Conditional rendering
{id ? <TodoComponent id={id} /> : <div>No ID</div>}
```

**Source**: [GitHub Discussion #6206](https://github.com/TanStack/query/discussions/6206)

---

## Error #6: initialPageParam Required

**Error Message**:
```
Property 'initialPageParam' is missing in type 'UseInfiniteQueryOptions'
```

**Why**:
v5 requires explicit `initialPageParam` for infinite queries

**Fix**:
```tsx
// ❌ v4
useInfiniteQuery({
  queryKey: ['projects'],
  queryFn: ({ pageParam = 0 }) => fetchProjects(pageParam),
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})

// ✅ v5
useInfiniteQuery({
  queryKey: ['projects'],
  queryFn: ({ pageParam }) => fetchProjects(pageParam),
  initialPageParam: 0, // Required
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})
```

**Source**: [v5 Migration](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#new-required-initialPageParam-option)

---

## Error #7: keepPreviousData Not Working

**Error Message**:
```
Property 'keepPreviousData' does not exist on type 'UseQueryOptions'
```

**Why**:
Replaced with `placeholderData` function

**Fix**:
```tsx
// ❌ v4
keepPreviousData: true

// ✅ v5
import { keepPreviousData } from '@tanstack/react-query'

placeholderData: keepPreviousData
```

**Source**: [v5 Migration](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#removed-keeppreviousdata-in-favor-of-placeholderdata-identity-function)

---

## Error #8: TypeScript Error Type

**Error Message**:
Type errors when handling non-Error objects

**Why**:
v5 defaults to `Error` type instead of `unknown`

**Fix**:
```tsx
// If throwing non-Error types, specify explicitly:
const { error } = useQuery<DataType, string>({
  queryKey: ['data'],
  queryFn: async () => {
    if (fail) throw 'custom error string'
    return data
  },
})

// Better: Always throw Error objects
throw new Error('Custom error')
```

**Source**: [v5 Migration](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#typeerror-is-now-the-default-error)

---

## Error #9: Query Not Refetching

**Symptoms**:
Data never updates even when stale

**Why**:
Usually config issue - check staleTime, refetch options

**Fix**:
```tsx
// Check these settings
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  staleTime: 0, // Data stale immediately
  refetchOnWindowFocus: true,
  refetchOnMount: true,
  refetchOnReconnect: true,
})

// Or manually refetch
const { refetch } = useQuery(...)
refetch()

// Or invalidate
queryClient.invalidateQueries({ queryKey: ['todos'] })
```

---

## Error #10: Mutations Not Invalidating

**Symptoms**:
UI doesn't update after mutation

**Why**:
Forgot to invalidate queries

**Fix**:
```tsx
useMutation({
  mutationFn: addTodo,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['todos'] }) // ✅ Required
  },
})
```

---

## Error #11: Network Errors Not Caught

**Symptoms**:
App crashes on network errors

**Why**:
Not handling errors properly

**Fix**:
```tsx
// Always handle errors
const { data, error, isError } = useQuery({
  queryKey: ['todos'],
  queryFn: async () => {
    const response = await fetch('/api/todos')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`) // ✅ Throw errors
    }
    return response.json()
  },
})

if (isError) return <div>Error: {error.message}</div>
```

---

## Error #12: Stale Closure in Callbacks

**Symptoms**:
Mutation callbacks use old data

**Why**:
Closure captures stale values

**Fix**:
```tsx
// ❌ Stale closure
const [value, setValue] = useState(0)
useMutation({
  onSuccess: () => {
    console.log(value) // Stale!
  },
})

// ✅ Use functional update
useMutation({
  onSuccess: () => {
    setValue(prev => prev + 1) // Fresh value
  },
})
```

---

## Quick Diagnosis Checklist

- [ ] Using v5 object syntax?
- [ ] Using `isPending` instead of `isLoading`?
- [ ] Using `gcTime` instead of `cacheTime`?
- [ ] No query callbacks (`onSuccess`, etc.)?
- [ ] `initialPageParam` present for infinite queries?
- [ ] Throwing errors in queryFn?
- [ ] Invalidating queries after mutations?
- [ ] Check DevTools for query state
