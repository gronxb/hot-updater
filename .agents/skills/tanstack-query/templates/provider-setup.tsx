// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { queryClient } from './lib/query-client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      {/* DevTools are automatically removed in production builds */}
      <ReactQueryDevtools
        initialIsOpen={false}
        buttonPosition="bottom-right"
        position="bottom"
      />
    </QueryClientProvider>
  </StrictMode>
)

/**
 * Important notes:
 *
 * 1. QueryClientProvider must wrap all components that use TanStack Query hooks
 * 2. DevTools must be inside the provider
 * 3. DevTools are tree-shaken in production (safe to leave in code)
 * 4. Only create ONE QueryClient instance for entire app (imported from query-client.ts)
 *
 * DevTools configuration options:
 * - initialIsOpen: true/false - Start open or closed
 * - buttonPosition: "top-left" | "top-right" | "bottom-left" | "bottom-right"
 * - position: "top" | "bottom" | "left" | "right"
 * - toggleButtonProps: Custom button styles
 * - panelProps: Custom panel styles
 *
 * Example with custom styles:
 * <ReactQueryDevtools
 *   initialIsOpen={false}
 *   buttonPosition="bottom-right"
 *   toggleButtonProps={{
 *     style: { marginBottom: '4rem' }
 *   }}
 *   panelProps={{
 *     style: { height: '500px' }
 *   }}
 * />
 */
