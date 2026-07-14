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

Replace the legacy database adapter API with the fixed-model adapter API for
`bundles`, `bundle_patches`, and `channels`. Database providers now return a
direct adapter object, aggregate bundle behavior is provided by the shared
database client, callback transactions and optimized update checks are
optional capabilities, and the v1 staged mutation API has been removed.
Provider functions now receive their configuration directly and close over it
inside `createDatabaseAdapter({ name, adapter })`.

Normalize channel storage as `channels { id, name }` with unique names and
`bundles.channel_id -> channels.id`, while double-writing the channel name to
the legacy `bundles.channel` field for backwards-compatible readers and
preserving channel names in the public bundle and standalone HTTP APIs.

Publish `@hot-updater/test-utils` with reusable low-adapter and aggregate-client
conformance suites for custom database adapter authors.

Expose transition-event analytics as an optional database capability and proxy
the management summary, analytics, installation search, and installation history
routes through the standalone repository so `hot-updater console` reports real
installed and recovered counts for standalone backends.
