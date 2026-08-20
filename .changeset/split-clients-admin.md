---
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/test-utils": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
"@hot-updater/react-native": patch
"hot-updater": patch
---

Split the self-hosted HTTP runtime into mount-relative
`handlers.client` and `handlers.admin` surfaces. Admin authentication now
belongs entirely to framework middleware, mounting the admin handler is the
explicit opt-in, and admin responses are marked private and non-cacheable.

Move the canonical admin root from `/hot-updater/api` to
`/hot-updater/admin`. `standaloneRepository.baseUrl` now points directly to
that root and sends mount-relative Bundle, Release, Release Catalog, Channel,
and database-commit requests. Managed runtimes mount only the client handler.

Remove the `features` wrapper, including `features.bundles`,
`features.updateCheck`, and Analytics `queryAccess`. `analytics` and
`clientAccessKeys` are top-level opt-in booleans that default to `false`. The
client handler always owns update routes, Analytics ingestion stays on the
client surface, and Analytics queries move to the admin surface.
`toNodeHandler` now accepts one handler function. React Native keeps the same
client `baseURL` and resolves handler-relative storage paths against it,
removing the server's `basePath` option. Client authentication uses `x-api-key`,
not an admin bearer token.

Resolve Expo fingerprint mode from the target app's dependencies so bare React
Native fingerprints stay stable across monorepo and isolated installs.
