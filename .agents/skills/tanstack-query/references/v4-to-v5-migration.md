# TanStack Query v4 to v5 Migration Guide

**Complete migration checklist for upgrading from React Query v4 to TanStack Query v5**

---

## Breaking Changes Summary

### 1. Object Syntax Required ⚠️

**v4** allowed multiple signatures:
```tsx
useQuery(['todos'], fetchTodos, { staleTime: 5000 })
useQuery(['todos'], fetchTodos)
useQuery(queryOptions)
```

**v5** only supports object syntax:
```tsx
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  staleTime: 5000
})
```

**Migration**: Use codemod or manual update
```bash
npx @tanstack/react-query-codemod v5/remove-overloads
```

### 2. Query Callbacks Removed ⚠️

**Removed from queries** (still work in mutations):
- `onSuccess`
- `onError`
- `onSettled`

**v4**:
```tsx
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  onSuccess: (data) => console.log(data) // ❌ Removed
})
```

**v5** - Use `useEffect`:
```tsx
const { data } = useQuery({ queryKey: ['todos'], queryFn: fetchTodos })

useEffect(() => {
  if (data) {
    console.log(data)
  }
}, [data])
```

**Mutation callbacks still work**:
```tsx
useMutation({
  mutationFn: addTodo,
  onSuccess: () => {} // ✅ Still works
})
```

### 3. `isLoading` → `isPending` ⚠️

**v4**: `isLoading` meant "no data yet"
**v5**: `isPending` means "no data yet", `isLoading` = `isPending && isFetching`

```tsx
// v4
const { data, isLoading } = useQuery(...)
if (isLoading) return <Loading />

// v5
const { data, isPending } = useQuery(...)
if (isPending) return <Loading />
```

### 4. `cacheTime` → `gcTime` ⚠️

```tsx
// v4
cacheTime: 1000 * 60 * 60

// v5
gcTime: 1000 * 60 * 60
```

### 5. `initialPageParam` Required for Infinite Queries ⚠️

```tsx
// v4
useInfiniteQuery({
  queryKey: ['projects'],
  queryFn: ({ pageParam = 0 }) => fetchProjects(pageParam),
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})

// v5
useInfiniteQuery({
  queryKey: ['projects'],
  queryFn: ({ pageParam }) => fetchProjects(pageParam),
  initialPageParam: 0, // ✅ Required
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})
```

### 6. `keepPreviousData` → `placeholderData` ⚠️

```tsx
// v4
keepPreviousData: true

// v5
import { keepPreviousData } from '@tanstack/react-query'

placeholderData: keepPreviousData
```

### 7. `useErrorBoundary` → `throwOnError` ⚠️

```tsx
// v4
useErrorBoundary: true

// v5
throwOnError: true

// Or conditional:
throwOnError: (error) => error.status >= 500
```

### 8. Error Type Default Changed

**v4**: `error: unknown`
**v5**: `error: Error`

If throwing non-Error types:
```tsx
const { error } = useQuery<DataType, string>({
  queryKey: ['data'],
  queryFn: async () => {
    if (fail) throw 'custom string error'
    return data
  },
})
```

---

## Step-by-Step Migration

### Step 1: Update Packages

```bash
npm install @tanstack/react-query@latest
npm install -D @tanstack/react-query-devtools@latest
```

### Step 2: Run Codemods

```bash
# Remove function overloads
npx @tanstack/react-query-codemod v5/remove-overloads

# Replace removed/renamed methods
npx @tanstack/react-query-codemod v5/rename-properties
```

### Step 3: Manual Fixes

1. Replace query callbacks with useEffect
2. Replace `isLoading` with `isPending`
3. Replace `cacheTime` with `gcTime`
4. Add `initialPageParam` to infinite queries
5. Replace `keepPreviousData` with `placeholderData`

### Step 4: TypeScript Fixes

Update type imports:
```tsx
// v4
import type { UseQueryResult } from 'react-query'

// v5
import type { UseQueryResult } from '@tanstack/react-query'
```

### Step 5: Test Thoroughly

- Check all queries work
- Verify mutations invalidate correctly
- Test error handling
- Check infinite queries
- Verify TypeScript types

---

## Common Migration Issues

### Issue: Callbacks not firing
**Cause**: Query callbacks removed
**Fix**: Use useEffect or move to mutations

### Issue: isLoading always false
**Cause**: Meaning changed
**Fix**: Use isPending for initial load

### Issue: cacheTime not recognized
**Cause**: Renamed
**Fix**: Use gcTime

### Issue: infinite query type error
**Cause**: initialPageParam required
**Fix**: Add initialPageParam

---

## Full Codemod List

```bash
# All v5 codemods
npx @tanstack/react-query-codemod v5/remove-overloads
npx @tanstack/react-query-codemod v5/rename-properties
npx @tanstack/react-query-codemod v5/replace-imports
```

**Note**: Codemods may not catch everything - manual review required!
