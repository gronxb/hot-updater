---
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
"@hot-updater/cli-tools": patch
"@hot-updater/console": patch
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
"@hot-updater/standalone": patch
"hot-updater": patch
---

`createHotUpdater` takes one storage adapter, `storage: s3Storage({ ... })`, the same adapter `hot-updater.config.ts` uploads with, and `hotUpdater.storage` is that adapter. `setupDatabaseTestSuite`'s `createHttpClient` receives one adapter too.

`clientAccess` takes only `"public"`. Options that no longer exist, in `createHotUpdater` and `hot-updater.config.ts`, are left to TypeScript instead of runtime checks.

A Release Catalog path with a channel name in place of its key, or a malformed fingerprint hash, answers `400` instead of `500`. `standaloneRepository` stops with a message when `baseUrl` points at the client mount instead of `handlers.admin`. `hot-updater init` no longer writes a storage call that uses a helper it removed.
