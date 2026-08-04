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
"@hot-updater/core": minor
"hot-updater": minor
---

Replace the legacy database plugin API with a fixed-model API for `bundles`
and `bundle_patches`. Providers now return a direct plugin object, while the
shared database client supplies aggregate bundle operations. Callback
transactions and optimized update checks are optional capabilities; the v1
factory, request-context, staged mutation, unit-of-work, and `commitBundle`
contracts have been removed.

Keep channel names on `bundles.channel`; this release does not add a channel
model, table, collection, or foreign key. The shared client can derive sorted,
distinct channel names when a provider does not implement the optimized
aggregate.

The shared client pages and orders bundle owners in the provider before
hydrating selected patches and referenced base bundles. Bundle updates forward
only caller-present scalar fields. Replacing patches and patch-bearing inserts
require either a provider transaction or a provider-native atomic aggregate
mutation; both fail before mutation when neither is available. Supabase uses
service-role-only database functions for these per-bundle mutations and still
does not expose a general callback transaction. The shared multi-read hydration
fallback does not promise snapshot isolation; providers needing that guarantee
should implement the optimized update-check capability. MongoDB exposes
transactions when configured with `transactions: true`.

Core's generic server schema registry ends at `0.36.0`. Kysely and MongoDB
migrators record that revision under `schema.core`; known legacy post-Core
`version` values are retained and interpreted as Core `0.36.0` compatibility,
not rewritten. Unknown future legacy revisions remain blocked. Managed
Cloudflare and Supabase deployments continue to use provider-native migration
history, while Firebase uses `database_adapter_version`. This release adds no
other schema namespace or database model.

Blob database snapshots contain only bundles and patches. Core refuses to read
or replace a snapshot containing unknown snapshot, row, or revision-pointer
fields, preventing silent data loss without claiming ownership of those fields.
Derived manifests use separate app-version and fingerprint namespaces with
encoded segments, while unsafe cache-route segments fail before commit.
Mutation success follows the active-pointer commit, and exhausted post-commit
invalidation reports through `onInvalidationError` without changing the
committed result.

The mock provider now accepts fixed bundle and patch rows through
`MockDatabaseData`. `@hot-updater/test-utils` publishes reusable low-level
plugin and aggregate-client conformance suites for custom provider authors.

Multi-platform deploy performs build, archive, and content-addressed upload
work before entering a retryable database transaction. The transaction callback
contains repeatable inserts only, and uploaded objects remain reusable when the
database commit fails. Multi-platform bundle creation uses one atomic array
request; servers reject the request before insertion when they cannot guarantee
atomicity.

Official providers honor every requested order clause and reject unsupported
distinct or string-comparison operations before I/O. PostgreSQL honors
requested null placement, and Cloudflare D1 rejects malformed count results
instead of returning zero.
