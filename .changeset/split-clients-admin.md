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

Remove `features.bundles` and Analytics `queryAccess`; Analytics ingestion
stays on the client surface while Analytics queries move to the admin surface.
`toNodeHandler` now accepts one handler function. React Native keeps the same
client `baseURL` and documents `x-api-key` rather than an admin bearer token.
Rename the server's generated-URL option from `basePath` to `clientBasePath`
and default it to `/`, matching a root-mounted client handler.

Resolve Expo fingerprint mode from the target app's dependencies so bare React
Native fingerprints stay stable across monorepo and isolated installs.
