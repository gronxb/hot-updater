# Testing TanStack Query

**Testing queries, mutations, and components**

---

## Setup

```bash
npm install -D @testing-library/react @testing-library/jest-dom vitest msw
```

### Test Utils

```tsx
// src/test-utils.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, // Disable retries in tests
        gcTime: Infinity,
      },
    },
    logger: {
      log: console.log,
      warn: console.warn,
      error: () => {}, // Silence errors in tests
    },
  })
}

export function renderWithClient(ui: React.ReactElement) {
  const testQueryClient = createTestQueryClient()
  return render(
    <QueryClientProvider client={testQueryClient}>
      {ui}
    </QueryClientProvider>
  )
}
```

---

## Testing Queries

```tsx
import { renderHook, waitFor } from '@testing-library/react'
import { useTodos } from './useTodos'

describe('useTodos', () => {
  it('fetches todos successfully', async () => {
    const { result } = renderHook(() => useTodos(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={createTestQueryClient()}>
          {children}
        </QueryClientProvider>
      ),
    })

    // Initially pending
    expect(result.current.isPending).toBe(true)

    // Wait for success
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // Check data
    expect(result.current.data).toHaveLength(3)
  })

  it('handles errors', async () => {
    // Mock fetch to fail
    global.fetch = vi.fn(() =>
      Promise.reject(new Error('API error'))
    )

    const { result } = renderHook(() => useTodos())

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('API error')
  })
})
```

---

## Testing with MSW

```tsx
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

const server = setupServer(
  http.get('/api/todos', () => {
    return HttpResponse.json([
      { id: 1, title: 'Test todo', completed: false },
    ])
  })
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

test('fetches todos', async () => {
  const { result } = renderHook(() => useTodos())

  await waitFor(() => expect(result.current.isSuccess).toBe(true))

  expect(result.current.data).toEqual([
    { id: 1, title: 'Test todo', completed: false },
  ])
})

test('handles server error', async () => {
  server.use(
    http.get('/api/todos', () => {
      return new HttpResponse(null, { status: 500 })
    })
  )

  const { result } = renderHook(() => useTodos())

  await waitFor(() => expect(result.current.isError).toBe(true))
})
```

---

## Testing Mutations

```tsx
test('adds todo successfully', async () => {
  const { result } = renderHook(() => useAddTodo())

  act(() => {
    result.current.mutate({ title: 'New todo' })
  })

  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toEqual(
    expect.objectContaining({ title: 'New todo' })
  )
})

test('handles mutation error', async () => {
  server.use(
    http.post('/api/todos', () => {
      return new HttpResponse(null, { status: 400 })
    })
  )

  const { result } = renderHook(() => useAddTodo())

  act(() => {
    result.current.mutate({ title: 'New todo' })
  })

  await waitFor(() => expect(result.current.isError).toBe(true))
})
```

---

## Testing Components

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TodoList } from './TodoList'

test('displays todos', async () => {
  renderWithClient(<TodoList />)

  expect(screen.getByText(/loading/i)).toBeInTheDocument()

  await waitFor(() => {
    expect(screen.getByText('Test todo')).toBeInTheDocument()
  })
})

test('adds new todo', async () => {
  renderWithClient(<TodoList />)

  await waitFor(() => {
    expect(screen.getByText('Test todo')).toBeInTheDocument()
  })

  const input = screen.getByPlaceholderText(/new todo/i)
  const button = screen.getByRole('button', { name: /add/i })

  await userEvent.type(input, 'Another todo')
  await userEvent.click(button)

  await waitFor(() => {
    expect(screen.getByText('Another todo')).toBeInTheDocument()
  })
})
```

---

## Testing with Prefilled Cache

```tsx
test('uses prefilled cache', () => {
  const queryClient = createTestQueryClient()

  // Prefill cache
  queryClient.setQueryData(['todos'], [
    { id: 1, title: 'Cached todo', completed: false },
  ])

  render(
    <QueryClientProvider client={queryClient}>
      <TodoList />
    </QueryClientProvider>
  )

  // Should immediately show cached data
  expect(screen.getByText('Cached todo')).toBeInTheDocument()
})
```

---

## Testing Optimistic Updates

```tsx
test('optimistic update rollback on error', async () => {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(['todos'], [
    { id: 1, title: 'Original', completed: false },
  ])

  server.use(
    http.patch('/api/todos/1', () => {
      return new HttpResponse(null, { status: 500 })
    })
  )

  const { result } = renderHook(() => useUpdateTodo(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })

  act(() => {
    result.current.mutate({ id: 1, completed: true })
  })

  // Check optimistic update
  expect(queryClient.getQueryData(['todos'])).toEqual([
    { id: 1, title: 'Original', completed: true },
  ])

  // Wait for rollback
  await waitFor(() => expect(result.current.isError).toBe(true))

  // Should rollback
  expect(queryClient.getQueryData(['todos'])).toEqual([
    { id: 1, title: 'Original', completed: false },
  ])
})
```

---

## Best Practices

✅ Disable retries in tests
✅ Use MSW for consistent mocking
✅ Test loading, success, and error states
✅ Test optimistic updates and rollbacks
✅ Use waitFor for async updates
✅ Prefill cache when testing with existing data
✅ Silence console errors in tests
❌ Don't test implementation details
❌ Don't mock TanStack Query internals
