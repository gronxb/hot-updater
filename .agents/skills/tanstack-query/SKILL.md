---
name: tanstack-query
description: |
  Manage server state in React with TanStack Query v5. Covers useMutationState, simplified optimistic updates, throwOnError, network mode (offline/PWA), and infiniteQueryOptions.

  Use when setting up data fetching, fixing v4→v5 migration errors (object syntax, gcTime, isPending, keepPreviousData), or debugging SSR/hydration issues with streaming server components.
user-invocable: true
---

# TanStack Query (React Query) v5

**Last Updated**: 2026-01-20
**Versions**: @tanstack/react-query@5.90.19, @tanstack/react-query-devtools@5.91.2
**Requires**: React 18.0+ (useSyncExternalStore), TypeScript 4.7+ (recommended)

---

## v5 New Features

### useMutationState - Cross-Component Mutation Tracking

Access mutation state from anywhere without prop drilling:

```tsx
import { useMutationState } from '@tanstack/react-query'

function GlobalLoadingIndicator() {
  // Get all pending mutations
  const pendingMutations = useMutationState({
    filters: { status: 'pending' },
    select: (mutation) => mutation.state.variables,
  })

  if (pendingMutations.length === 0) return null
  return <div>Saving {pendingMutations.length} items...</div>
}

// Filter by mutation key
const todoMutations = useMutationState({
  filters: { mutationKey: ['addTodo'] },
})
```

### Simplified Optimistic Updates

New pattern using `variables` - no cache manipulation, no rollback needed:

```tsx
function TodoList() {
  const { data: todos } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos })

  const addTodo = useMutation({
    mutationKey: ['addTodo'],
    mutationFn: (newTodo) => api.addTodo(newTodo),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['todos'] })
    },
  })

  // Show optimistic UI using variables from pending mutations
  const pendingTodos = useMutationState({
    filters: { mutationKey: ['addTodo'], status: 'pending' },
    select: (mutation) => mutation.state.variables,
  })

  return (
    <ul>
      {todos?.map(todo => <li key={todo.id}>{todo.title}</li>)}
      {/* Show pending items with visual indicator */}
      {pendingTodos.map((todo, i) => (
        <li key={`pending-${i}`} style={{ opacity: 0.5 }}>{todo.title}</li>
      ))}
    </ul>
  )
}
```

### throwOnError - Error Boundaries

Renamed from `useErrorBoundary` (breaking change):

```tsx
import { QueryErrorResetBoundary } from '@tanstack/react-query'
import { ErrorBoundary } from 'react-error-boundary'

function App() {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary onReset={reset} fallbackRender={({ resetErrorBoundary }) => (
          <div>
            Error! <button onClick={resetErrorBoundary}>Retry</button>
          </div>
        )}>
          <Todos />
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  )
}

function Todos() {
  const { data } = useQuery({
    queryKey: ['todos'],
    queryFn: fetchTodos,
    throwOnError: true, // ✅ v5 (was useErrorBoundary in v4)
  })
  return <div>{data.map(...)}</div>
}
```

### Network Mode (Offline/PWA Support)

Control behavior when offline:

```tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'offlineFirst', // Use cache when offline
    },
  },
})

// Per-query override
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  networkMode: 'always', // Always try, even offline (for local APIs)
})
```

| Mode | Behavior |
|------|----------|
| `online` (default) | Only fetch when online |
| `always` | Always try (useful for local/service worker APIs) |
| `offlineFirst` | Use cache first, fetch when online |

**Detecting paused state:**
```tsx
const { isPending, fetchStatus } = useQuery(...)
// isPending + fetchStatus === 'paused' = offline, waiting for network
```

### useQueries with Combine

Combine results from parallel queries:

```tsx
const results = useQueries({
  queries: userIds.map(id => ({
    queryKey: ['user', id],
    queryFn: () => fetchUser(id),
  })),
  combine: (results) => ({
    data: results.map(r => r.data),
    pending: results.some(r => r.isPending),
    error: results.find(r => r.error)?.error,
  }),
})

// Access combined result
if (results.pending) return <Loading />
console.log(results.data) // [user1, user2, user3]
```

### infiniteQueryOptions Helper

Type-safe factory for infinite queries (parallel to `queryOptions`):

```tsx
import { infiniteQueryOptions, useInfiniteQuery, prefetchInfiniteQuery } from '@tanstack/react-query'

const todosInfiniteOptions = infiniteQueryOptions({
  queryKey: ['todos', 'infinite'],
  queryFn: ({ pageParam }) => fetchTodosPage(pageParam),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})

// Reuse across hooks
useInfiniteQuery(todosInfiniteOptions)
useSuspenseInfiniteQuery(todosInfiniteOptions)
prefetchInfiniteQuery(queryClient, todosInfiniteOptions)
```

### maxPages - Memory Optimization

Limit pages stored in cache for infinite queries:

```tsx
useInfiniteQuery({
  queryKey: ['posts'],
  queryFn: ({ pageParam }) => fetchPosts(pageParam),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  getPreviousPageParam: (firstPage) => firstPage.prevCursor, // Required with maxPages
  maxPages: 3, // Only keep 3 pages in memory
})
```

**Note:** `maxPages` requires bi-directional pagination (`getNextPageParam` AND `getPreviousPageParam`).

---

## Quick Setup

```bash
npm install @tanstack/react-query@latest
npm install -D @tanstack/react-query-devtools@latest
```

### Step 2: Provider + Config

```tsx
// src/main.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 min
      gcTime: 1000 * 60 * 60, // 1 hour (v5: renamed from cacheTime)
      refetchOnWindowFocus: false,
    },
  },
})

<QueryClientProvider client={queryClient}>
  <App />
  <ReactQueryDevtools initialIsOpen={false} />
</QueryClientProvider>
```

### Step 3: Query + Mutation Hooks

```tsx
// src/hooks/useTodos.ts
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query'

// Query options factory (v5 pattern)
export const todosQueryOptions = queryOptions({
  queryKey: ['todos'],
  queryFn: async () => {
    const res = await fetch('/api/todos')
    if (!res.ok) throw new Error('Failed to fetch')
    return res.json()
  },
})

export function useTodos() {
  return useQuery(todosQueryOptions)
}

export function useAddTodo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (newTodo) => {
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTodo),
      })
      if (!res.ok) throw new Error('Failed to add')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['todos'] })
    },
  })
}

// Usage:
function TodoList() {
  const { data, isPending, isError, error } = useTodos()
  const { mutate } = useAddTodo()

  if (isPending) return <div>Loading...</div>
  if (isError) return <div>Error: {error.message}</div>
  return <ul>{data.map(todo => <li key={todo.id}>{todo.title}</li>)}</ul>
}
```

---

## Critical Rules

### Always Do

✅ **Use object syntax for all hooks**
```tsx
// v5 ONLY supports this:
useQuery({ queryKey, queryFn, ...options })
useMutation({ mutationFn, ...options })
```

✅ **Use array query keys**
```tsx
queryKey: ['todos']              // List
queryKey: ['todos', id]          // Detail
queryKey: ['todos', { filter }]  // Filtered
```

✅ **Configure staleTime appropriately**
```tsx
staleTime: 1000 * 60 * 5 // 5 min - prevents excessive refetches
```

✅ **Use isPending for initial loading state**
```tsx
if (isPending) return <Loading />
// isPending = no data yet AND fetching
```

✅ **Throw errors in queryFn**
```tsx
if (!response.ok) throw new Error('Failed')
```

✅ **Invalidate queries after mutations**
```tsx
onSuccess: () => {
  queryClient.invalidateQueries({ queryKey: ['todos'] })
}
```

✅ **Use queryOptions factory for reusable patterns**
```tsx
const opts = queryOptions({ queryKey, queryFn })
useQuery(opts)
useSuspenseQuery(opts)
prefetchQuery(opts)
```

✅ **Use gcTime (not cacheTime)**
```tsx
gcTime: 1000 * 60 * 60 // 1 hour
```

### Never Do

❌ **Never use v4 array/function syntax**
```tsx
// v4 (removed in v5):
useQuery(['todos'], fetchTodos, options) // ❌

// v5 (correct):
useQuery({ queryKey: ['todos'], queryFn: fetchTodos }) // ✅
```

❌ **Never use query callbacks (onSuccess, onError, onSettled in queries)**
```tsx
// v5 removed these from queries:
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  onSuccess: (data) => {}, // ❌ Removed in v5
})

// Use useEffect instead:
const { data } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos })
useEffect(() => {
  if (data) {
    // Do something
  }
}, [data])

// Or use mutation callbacks (still supported):
useMutation({
  mutationFn: addTodo,
  onSuccess: () => {}, // ✅ Still works for mutations
})
```

❌ **Never use deprecated options**
```tsx
// Deprecated in v5:
cacheTime: 1000 // ❌ Use gcTime instead
isLoading: true // ❌ Meaning changed, use isPending
keepPreviousData: true // ❌ Use placeholderData instead
onSuccess: () => {} // ❌ Removed from queries
useErrorBoundary: true // ❌ Use throwOnError instead
```

❌ **Never assume isLoading means "no data yet"**
```tsx
// v5 changed this:
isLoading = isPending && isFetching // ❌ Now means "pending AND fetching"
isPending = no data yet // ✅ Use this for initial load
```

❌ **Never forget initialPageParam for infinite queries**
```tsx
// v5 requires this:
useInfiniteQuery({
  queryKey: ['projects'],
  queryFn: ({ pageParam }) => fetchProjects(pageParam),
  initialPageParam: 0, // ✅ Required in v5
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})
```

❌ **Never use enabled with useSuspenseQuery**
```tsx
// Not allowed:
useSuspenseQuery({
  queryKey: ['todo', id],
  queryFn: () => fetchTodo(id),
  enabled: !!id, // ❌ Not available with suspense
})

// Use conditional rendering instead:
{id && <TodoComponent id={id} />}
```

❌ **Never rely on refetchOnMount: false for errored queries**
```tsx
// Doesn't work - errors are always stale
useQuery({
  queryKey: ['data'],
  queryFn: failingFetch,
  refetchOnMount: false,  // ❌ Ignored when query has error
})

// Use retryOnMount instead
useQuery({
  queryKey: ['data'],
  queryFn: failingFetch,
  refetchOnMount: false,
  retryOnMount: false,  // ✅ Prevents refetch for errored queries
  retry: 0,
})
```

---

## Known Issues Prevention

This skill prevents **16 documented issues** from v5 migration, SSR/hydration bugs, and common mistakes:

### Issue #1: Object Syntax Required
**Error**: `useQuery is not a function` or type errors
**Source**: [v5 Migration Guide](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#removed-overloads-in-favor-of-object-syntax)
**Why It Happens**: v5 removed all function overloads, only object syntax works
**Prevention**: Always use `useQuery({ queryKey, queryFn, ...options })`

**Before (v4):**
```tsx
useQuery(['todos'], fetchTodos, { staleTime: 5000 })
```

**After (v5):**
```tsx
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  staleTime: 5000
})
```

### Issue #2: Query Callbacks Removed
**Error**: Callbacks don't run, TypeScript errors
**Source**: [v5 Breaking Changes](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#callbacks-on-usequery-and-queryobserver-have-been-removed)
**Why It Happens**: onSuccess, onError, onSettled removed from queries (still work in mutations)
**Prevention**: Use `useEffect` for side effects, or move logic to mutation callbacks

**Before (v4):**
```tsx
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  onSuccess: (data) => {
    console.log('Todos loaded:', data)
  },
})
```

**After (v5):**
```tsx
const { data } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos })
useEffect(() => {
  if (data) {
    console.log('Todos loaded:', data)
  }
}, [data])
```

### Issue #3: Status Loading → Pending
**Error**: UI shows wrong loading state
**Source**: [v5 Migration: isLoading renamed](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#isloading-and-isfetching-flags)
**Why It Happens**: `status: 'loading'` renamed to `status: 'pending'`, `isLoading` meaning changed
**Prevention**: Use `isPending` for initial load, `isLoading` for "pending AND fetching"

**Before (v4):**
```tsx
const { data, isLoading } = useQuery(...)
if (isLoading) return <div>Loading...</div>
```

**After (v5):**
```tsx
const { data, isPending, isLoading } = useQuery(...)
if (isPending) return <div>Loading...</div>
// isLoading = isPending && isFetching (fetching for first time)
```

### Issue #4: cacheTime → gcTime
**Error**: `cacheTime is not a valid option`
**Source**: [v5 Migration: gcTime](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#cachetime-has-been-replaced-by-gctime)
**Why It Happens**: Renamed to better reflect "garbage collection time"
**Prevention**: Use `gcTime` instead of `cacheTime`

**Before (v4):**
```tsx
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  cacheTime: 1000 * 60 * 60,
})
```

**After (v5):**
```tsx
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  gcTime: 1000 * 60 * 60,
})
```

### Issue #5: useSuspenseQuery + enabled
**Error**: Type error, enabled option not available
**Source**: [GitHub Discussion #6206](https://github.com/TanStack/query/discussions/6206)
**Why It Happens**: Suspense guarantees data is available, can't conditionally disable
**Prevention**: Use conditional rendering instead of `enabled` option

**Before (v4/incorrect):**
```tsx
useSuspenseQuery({
  queryKey: ['todo', id],
  queryFn: () => fetchTodo(id),
  enabled: !!id, // ❌ Not allowed
})
```

**After (v5/correct):**
```tsx
// Conditional rendering:
{id ? (
  <TodoComponent id={id} />
) : (
  <div>No ID selected</div>
)}

// Inside TodoComponent:
function TodoComponent({ id }: { id: number }) {
  const { data } = useSuspenseQuery({
    queryKey: ['todo', id],
    queryFn: () => fetchTodo(id),
    // No enabled option needed
  })
  return <div>{data.title}</div>
}
```

### Issue #6: initialPageParam Required
**Error**: `initialPageParam is required` type error
**Source**: [v5 Migration: Infinite Queries](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#new-required-initialPageParam-option)
**Why It Happens**: v4 passed `undefined` as first pageParam, v5 requires explicit value
**Prevention**: Always specify `initialPageParam` for infinite queries

**Before (v4):**
```tsx
useInfiniteQuery({
  queryKey: ['projects'],
  queryFn: ({ pageParam = 0 }) => fetchProjects(pageParam),
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})
```

**After (v5):**
```tsx
useInfiniteQuery({
  queryKey: ['projects'],
  queryFn: ({ pageParam }) => fetchProjects(pageParam),
  initialPageParam: 0, // ✅ Required
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})
```

### Issue #7: keepPreviousData Removed
**Error**: `keepPreviousData is not a valid option`
**Source**: [v5 Migration: placeholderData](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#removed-keeppreviousdata-in-favor-of-placeholderdata-identity-function)
**Why It Happens**: Replaced with more flexible `placeholderData` function
**Prevention**: Use `placeholderData: keepPreviousData` helper

**Before (v4):**
```tsx
useQuery({
  queryKey: ['todos', page],
  queryFn: () => fetchTodos(page),
  keepPreviousData: true,
})
```

**After (v5):**
```tsx
import { keepPreviousData } from '@tanstack/react-query'

useQuery({
  queryKey: ['todos', page],
  queryFn: () => fetchTodos(page),
  placeholderData: keepPreviousData,
})
```

### Issue #8: TypeScript Error Type Default
**Error**: Type errors with error handling
**Source**: [v5 Migration: Error Types](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5#typeerror-is-now-the-default-error)
**Why It Happens**: v4 used `unknown`, v5 defaults to `Error` type
**Prevention**: If throwing non-Error types, specify error type explicitly

**Before (v4 - error was unknown):**
```tsx
const { error } = useQuery({
  queryKey: ['data'],
  queryFn: async () => {
    if (Math.random() > 0.5) throw 'custom error string'
    return data
  },
})
// error: unknown
```

**After (v5 - specify custom error type):**
```tsx
const { error } = useQuery<DataType, string>({
  queryKey: ['data'],
  queryFn: async () => {
    if (Math.random() > 0.5) throw 'custom error string'
    return data
  },
})
// error: string | null

// Or better: always throw Error objects
const { error } = useQuery({
  queryKey: ['data'],
  queryFn: async () => {
    if (Math.random() > 0.5) throw new Error('custom error')
    return data
  },
})
// error: Error | null (default)
```

### Issue #9: Streaming Server Components Hydration Error
**Error**: `Hydration failed because the initial UI does not match what was rendered on the server`
**Source**: [GitHub Issue #9642](https://github.com/TanStack/query/issues/9642)
**Affects**: v5.82.0+ with streaming SSR (void prefetch pattern)
**Why It Happens**: Race condition where `hydrate()` resolves synchronously but `query.fetch()` creates async retryer, causing isFetching/isStale mismatch between server and client
**Prevention**: Don't conditionally render based on `fetchStatus` with `useSuspenseQuery` and streaming prefetch, OR await prefetch instead of void pattern

**Before (causes hydration error):**
```tsx
// Server: void prefetch
streamingQueryClient.prefetchQuery({ queryKey: ['data'], queryFn: getData });

// Client: conditional render on fetchStatus
const { data, isFetching } = useSuspenseQuery({ queryKey: ['data'], queryFn: getData });
return <>{data && <div>{data}</div>} {isFetching && <Loading />}</>;
```

**After (workaround):**
```tsx
// Option 1: Await prefetch
await streamingQueryClient.prefetchQuery({ queryKey: ['data'], queryFn: getData });

// Option 2: Don't render based on fetchStatus with Suspense
const { data } = useSuspenseQuery({ queryKey: ['data'], queryFn: getData });
return <div>{data}</div>;  // No conditional on isFetching
```

**Status**: Known issue, being investigated by maintainers. Requires implementation of `getServerSnapshot` in useSyncExternalStore.

### Issue #10: useQuery Hydration Error with Prefetching
**Error**: Text content mismatch during hydration
**Source**: [GitHub Issue #9399](https://github.com/TanStack/query/issues/9399)
**Affects**: v5.x with server-side prefetching
**Why It Happens**: `tryResolveSync` detects resolved promises in RSC payload and extracts data synchronously during hydration, bypassing normal pending state
**Prevention**: Use `useSuspenseQuery` instead of `useQuery` for SSR, or avoid conditional rendering based on `isLoading`

**Before (causes hydration error):**
```tsx
// Server Component
const queryClient = getServerQueryClient();
await queryClient.prefetchQuery({ queryKey: ['todos'], queryFn: fetchTodos });

// Client Component
function Todos() {
  const { data, isLoading } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos });
  if (isLoading) return <div>Loading...</div>;  // Server renders this
  return <div>{data.length} todos</div>;  // Client hydrates with this
}
```

**After (workaround):**
```tsx
// Use useSuspenseQuery instead
function Todos() {
  const { data } = useSuspenseQuery({ queryKey: ['todos'], queryFn: fetchTodos });
  return <div>{data.length} todos</div>;
}
```

**Status**: "At the top of my OSS list of things to fix" - maintainer Ephem (Nov 2025). Requires implementing `getServerSnapshot` in useSyncExternalStore.

### Issue #11: refetchOnMount Not Respected for Errored Queries
**Error**: Queries refetch on mount despite `refetchOnMount: false`
**Source**: [GitHub Issue #10018](https://github.com/TanStack/query/issues/10018)
**Affects**: v5.90.16+
**Why It Happens**: Errored queries with no data are always treated as stale. This is intentional to avoid permanently showing error states
**Prevention**: Use `retryOnMount: false` instead of (or in addition to) `refetchOnMount: false`

**Before (refetches despite setting):**
```tsx
const { data, error } = useQuery({
  queryKey: ['data'],
  queryFn: () => { throw new Error('Fails') },
  refetchOnMount: false,  // Ignored when query is in error state
  retry: 0,
});
// Query refetches every time component mounts
```

**After (correct):**
```tsx
const { data, error } = useQuery({
  queryKey: ['data'],
  queryFn: failingFetch,
  refetchOnMount: false,
  retryOnMount: false,  // ✅ Prevents refetch on mount for errored queries
  retry: 0,
});
```

**Status**: Documented behavior (intentional). The name `retryOnMount` is slightly misleading - it controls whether errored queries trigger a new fetch on mount, not automatic retries.

### Issue #12: Mutation Callback Signature Breaking Change (v5.89.0)
**Error**: TypeScript errors in mutation callbacks
**Source**: [GitHub Issue #9660](https://github.com/TanStack/query/issues/9660)
**Affects**: v5.89.0+
**Why It Happens**: `onMutateResult` parameter added between `variables` and `context`, changing callback signatures from 3 params to 4
**Prevention**: Update all mutation callbacks to accept 4 parameters instead of 3

**Before (v5.88 and earlier):**
```tsx
useMutation({
  mutationFn: addTodo,
  onError: (error, variables, context) => {
    // context is now onMutateResult, missing final context param
  },
  onSuccess: (data, variables, context) => {
    // Same issue
  }
});
```

**After (v5.89.0+):**
```tsx
useMutation({
  mutationFn: addTodo,
  onError: (error, variables, onMutateResult, context) => {
    // onMutateResult = return value from onMutate
    // context = mutation function context
  },
  onSuccess: (data, variables, onMutateResult, context) => {
    // Correct signature with 4 parameters
  }
});
```

**Note**: If you don't use `onMutate`, the `onMutateResult` parameter will be undefined. This breaking change was introduced in a patch version.

### Issue #13: Readonly Query Keys Break Partial Matching (v5.90.8)
**Error**: `Type 'readonly ["todos", string]' is not assignable to type '["todos", string]'`
**Source**: [GitHub Issue #9871](https://github.com/TanStack/query/issues/9871) | Fixed in [PR #9872](https://github.com/TanStack/query/pull/9872)
**Affects**: v5.90.8 only (fixed in v5.90.9)
**Why It Happens**: Partial query matching broke TypeScript types for readonly query keys (using `as const`)
**Prevention**: Upgrade to v5.90.9+ or use type assertions if stuck on v5.90.8

**Before (v5.90.8 - TypeScript error):**
```tsx
export function todoQueryKey(id?: string) {
  return id ? ['todos', id] as const : ['todos'] as const;
}
// Type: readonly ['todos', string] | readonly ['todos']

useMutation({
  mutationFn: addTodo,
  onSuccess: () => {
    queryClient.invalidateQueries({
      queryKey: todoQueryKey('123')
      // Error: readonly ['todos', string] not assignable to ['todos', string]
    });
  }
});
```

**After (v5.90.9+):**
```tsx
// Works correctly with readonly types
queryClient.invalidateQueries({
  queryKey: todoQueryKey('123')  // ✅ No type error
});
```

**Status**: Fixed in v5.90.9. Particularly affected users of code generators like `openapi-react-query` that produce readonly query keys.

### Issue #14: useMutationState Type Inference Lost
**Error**: `mutation.state.variables` typed as `unknown` instead of actual type
**Source**: [GitHub Issue #9825](https://github.com/TanStack/query/issues/9825)
**Affects**: All v5.x versions
**Why It Happens**: Fuzzy mutation key matching prevents guaranteed type inference (same issue as `queryClient.getQueryCache().find()`)
**Prevention**: Explicitly cast types in the `select` callback

**Before (type inference doesn't work):**
```tsx
const addTodo = useMutation({
  mutationKey: ['addTodo'],
  mutationFn: (todo: Todo) => api.addTodo(todo),
});

const pendingTodos = useMutationState({
  filters: { mutationKey: ['addTodo'], status: 'pending' },
  select: (mutation) => {
    return mutation.state.variables;  // Type: unknown
  },
});
```

**After (with explicit cast):**
```tsx
const pendingTodos = useMutationState({
  filters: { mutationKey: ['addTodo'], status: 'pending' },
  select: (mutation) => mutation.state.variables as Todo,
});
// Or cast the entire state:
select: (mutation) => mutation.state as MutationState<Todo, Error, Todo, unknown>
```

**Status**: Known limitation of fuzzy matching. No planned fix.

### Issue #15: Query Cancellation in StrictMode with fetchQuery
**Error**: `CancelledError` when using `fetchQuery()` with `useQuery`
**Source**: [GitHub Issue #9798](https://github.com/TanStack/query/issues/9798)
**Affects**: Development only (React StrictMode)
**Why It Happens**: StrictMode causes double mount/unmount. When `useQuery` unmounts and is the last observer, it cancels the query even if `fetchQuery()` is also running
**Prevention**: This is expected development-only behavior. Doesn't affect production

**Example:**
```tsx
async function loadData() {
  try {
    const data = await queryClient.fetchQuery({
      queryKey: ['data'],
      queryFn: fetchData,
    });
    console.log('Loaded:', data);  // Never logs in StrictMode
  } catch (error) {
    console.error('Failed:', error);  // CancelledError
  }
}

function Component() {
  const { data } = useQuery({ queryKey: ['data'], queryFn: fetchData });
  // In StrictMode, component unmounts/remounts, cancelling fetchQuery
}
```

**Workaround:**
```tsx
// Keep query observed with staleTime
const { data } = useQuery({
  queryKey: ['data'],
  queryFn: fetchData,
  staleTime: Infinity,  // Keeps query active
});
```

**Status**: Expected StrictMode behavior, not a bug. Production builds are unaffected.

### Issue #16: invalidateQueries Only Refetches Active Queries
**Error**: Inactive queries not refetching despite `invalidateQueries()` call
**Source**: [GitHub Issue #9531](https://github.com/TanStack/query/issues/9531)
**Affects**: All v5.x versions
**Why It Happens**: Documentation was misleading - `invalidateQueries()` only refetches "active" queries by default, not "all" queries
**Prevention**: Use `refetchType: 'all'` to force refetch of inactive queries

**Default behavior:**
```tsx
// Only active queries (currently being observed) will refetch
queryClient.invalidateQueries({ queryKey: ['todos'] });
```

**To refetch inactive queries:**
```tsx
queryClient.invalidateQueries({
  queryKey: ['todos'],
  refetchType: 'all'  // Refetch active AND inactive
});
```

**Status**: Documentation fixed to clarify "active" queries. This is the intended behavior.

---

## Community Tips

> **Note**: These tips come from community experts and maintainer blogs. Verify against your version.

### Tip: Query Options with Multiple Listeners

**Source**: [TkDodo's Blog - API Design Lessons](https://tkdodo.eu/blog/react-query-api-design-lessons-learned) | **Confidence**: HIGH
**Applies to**: v5.27.3+

When multiple components use the same query with different options (like `staleTime`), the "last write wins" rule applies for future fetches, but the current in-flight query uses its original options. This can cause unexpected behavior when components mount at different times.

**Example of unexpected behavior:**
```tsx
// Component A mounts first
function ComponentA() {
  const { data } = useQuery({
    queryKey: ['todos'],
    queryFn: fetchTodos,
    staleTime: 5000,  // Applied initially
  });
}

// Component B mounts while A's query is in-flight
function ComponentB() {
  const { data } = useQuery({
    queryKey: ['todos'],
    queryFn: fetchTodos,
    staleTime: 60000,  // Won't affect current fetch, only future ones
  });
}
```

**Recommended approach:**
```tsx
// Write options as functions that reference latest values
const getStaleTime = () => shouldUseLongCache ? 60000 : 5000;

useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  staleTime: getStaleTime(),  // Evaluated on each render
});
```

### Tip: refetch() is NOT for Changed Parameters

**Source**: [Avoiding Common Mistakes with TanStack Query](https://www.buncolak.com/posts/avoiding-common-mistakes-with-tanstack-query-part-1/) | **Confidence**: HIGH

The `refetch()` function should ONLY be used for refreshing with the same parameters (like a manual "reload" button). For new parameters (filters, page numbers, search terms, etc.), include them in the query key instead.

**Anti-pattern:**
```tsx
// ❌ Wrong - using refetch() for different parameters
const [page, setPage] = useState(1);
const { data, refetch } = useQuery({
  queryKey: ['todos'],  // Same key for all pages
  queryFn: () => fetchTodos(page),
});

// This refetches with OLD page value, not new one
<button onClick={() => { setPage(2); refetch(); }}>Next</button>
```

**Correct pattern:**
```tsx
// ✅ Correct - include parameters in query key
const [page, setPage] = useState(1);
const { data } = useQuery({
  queryKey: ['todos', page],  // Key changes with page
  queryFn: () => fetchTodos(page),
  // Query automatically refetches when page changes
});

<button onClick={() => setPage(2)}>Next</button>  // Just update state
```

**When to use refetch():**
```tsx
// ✅ Manual refresh of same data (refresh button)
const { data, refetch } = useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
});

<button onClick={() => refetch()}>Refresh</button>  // Same parameters
```

---

## Key Patterns

**Dependent Queries** (Query B waits for Query A):
```tsx
const { data: posts } = useQuery({
  queryKey: ['users', userId, 'posts'],
  queryFn: () => fetchUserPosts(userId),
  enabled: !!user, // Wait for user
})
```

**Parallel Queries** (fetch multiple at once):
```tsx
const results = useQueries({
  queries: ids.map(id => ({ queryKey: ['todos', id], queryFn: () => fetchTodo(id) })),
})
```

**Prefetching** (preload on hover):
```tsx
queryClient.prefetchQuery({ queryKey: ['todo', id], queryFn: () => fetchTodo(id) })
```

**Infinite Scroll** (useInfiniteQuery):
```tsx
useInfiniteQuery({
  queryKey: ['todos', 'infinite'],
  queryFn: ({ pageParam }) => fetchTodosPage(pageParam),
  initialPageParam: 0, // Required in v5
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})
```

**Query Cancellation** (auto-cancel on queryKey change):
```tsx
queryFn: async ({ signal }) => {
  const res = await fetch(`/api/todos?q=${search}`, { signal })
  return res.json()
}
```

**Data Transformation** (select):
```tsx
select: (data) => data.filter(todo => todo.completed)
```

**Avoid Request Waterfalls**: Fetch in parallel when possible (don't chain queries unless truly dependent)

---

**Official Docs**: https://tanstack.com/query/latest | **v5 Migration**: https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5 | **GitHub**: https://github.com/TanStack/query | **Context7**: `/websites/tanstack_query`
