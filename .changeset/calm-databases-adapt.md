---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/mock": minor
"@hot-updater/postgres": minor
"@hot-updater/standalone": minor
"@hot-updater/supabase": minor
"@hot-updater/cli-tools": minor
"@hot-updater/console": minor
"hot-updater": minor
---

Replace database plugin v1 with the fixed-model database adapter API for
`bundles`, `bundle_patches`, and `channels`. Database providers now return a
direct adapter object, aggregate bundle behavior is provided by the shared
database client, callback transactions and optimized update checks are
optional capabilities, and the v1 staged mutation API has been removed.

Publish `@hot-updater/test-utils` with reusable low-adapter and aggregate-client
conformance suites for custom database adapter authors.
