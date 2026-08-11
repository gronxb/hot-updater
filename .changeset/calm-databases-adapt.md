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

Replace the legacy database plugin API with a fixed, one-depth official-domain
contract. Providers return `bundles`, `bundlePatches`, `analytics`,
`clientAccessKeys`, and the atomic `commit` boundary directly from
`createDatabasePlugin`. Provider callback transactions and generic CRUD remain
implementation details; `commit({ mutations })` atomically applies any number
of bundle change-sets. The v1 factory, nested `plugin`, request-context, staged
mutation, unit-of-work, `commitBatch`, lifecycle callback, generic capability,
and universal component contracts have been removed.

Keep channel names on `bundles.channel`; this release does not add a channel
model, table, collection, or foreign key. The shared client can derive sorted,
distinct channel names when a provider does not implement the optimized
aggregate.

The shared client pages and orders bundle owners in the provider before
hydrating selected patches and referenced base bundles. Bundle updates forward
only caller-present scalar fields. Replacing patches and patch-bearing inserts
are one change-set across the two tables and fail before mutation when the
provider cannot commit that set atomically. Supabase uses service-role-only
database functions for these commits. Cloudflare D1 uses transactional batches
through both its HTTP and Worker APIs. The shared multi-read hydration fallback
does not promise snapshot isolation; providers needing that guarantee should
implement the optimized update-check capability. MongoDB supports cross-table
commits when configured with `transactions: true` and rejects them otherwise.

Core schema `0.37.0` adds the official `bundle_events` and
`client_access_keys` models. Kysely, MongoDB, D1, Supabase, Firebase, and the
official provider adapters map those models through their native schema and
migration mechanisms. Known legacy post-Core `version` values remain
compatible with Core `0.36.0`; unknown future revisions remain blocked.

The mock provider now accepts every official row through `MockDatabaseData`.
`@hot-updater/test-utils` publishes reusable official-domain plugin and
aggregate-client conformance suites for custom provider authors.

Multi-platform deploy performs build, archive, and content-addressed upload
work before preparing database change-sets. Providers receive the prepared
change-sets once through `commit`, so provider retries cannot rerun build
or upload side effects. Uploaded objects remain reusable when the database
commit fails. Multi-platform bundle creation uses one atomic array request;
servers reject the request before insertion when they cannot guarantee
atomicity.

Official providers implement the fixed bundle access patterns used by the
shared client: exact domain filters, id ordering, bounded pagination, row
counts, patch lookup by owner ids, and atomic bundle change-sets. Arbitrary
distinct, projection, connector, and string-comparison query DSL operations are
no longer part of the public database plugin contract. Cloudflare D1 rejects
malformed count results instead of returning zero.
