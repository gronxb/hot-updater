---
"@hot-updater/aws": minor
"@hot-updater/cli-tools": minor
"@hot-updater/cloudflare": minor
"@hot-updater/console": minor
"@hot-updater/core": minor
"@hot-updater/firebase": minor
"@hot-updater/js": minor
"@hot-updater/mock": minor
"@hot-updater/plugin-core": minor
"@hot-updater/postgres": minor
"@hot-updater/react-native": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/supabase": minor
"@hot-updater/test-utils": minor
"hot-updater": minor
---

Separate immutable Bundle artifacts from mutable Release policy and compile
policy changes ahead of time into deterministic Release catalogs.
Database plugins now expose Release and catalog models plus atomic Release
revision/catalog generation expectations, and no longer expose provider update
decision queries.

Add canonical v2 Release-catalog and Bundle-artifact routes, short-lived
authenticated shared caching, a v1-only device protocol boundary, Release
management commands, catalog preflight/rebuild tooling, and a familiar Bundle
management view backed by Releases. The Console keeps Bundle content, delivery settings,
promote, and download actions in one workflow while Release identity stays
secondary. Deploy and promote create Releases; rollback disables the current
Release so clients select the previous compatible enabled Release or the
built-in app. Rollout, targeting, enablement, and messages mutate Releases
while patch, manifest, signing, and storage behavior remain Bundle-keyed.
Release IDs are canonical UUIDv7 values. Console shadcn primitives now use Base
UI instead of Radix while preserving the existing management flow and visual
density.

React Native clients select desired Releases locally, persist authority/scope
generation high-water and full Release/Bundle receipts, support same-Bundle
adoption and authenticated BUILTIN fallback, and use generation/context CAS so
stale artifact work cannot commit. New catalogs retain an 11-artifact update
frontier plus the complete compatible enabled rollback spine, so rollback keeps
v0 predecessor semantics even for old active clients. The 256 KiB catalog cap
remains atomic: an oversized history rejects the Release mutation instead of
silently truncating rollback candidates. Analytics events now carry directional
Release identity alongside Bundle identity.

Migrate SQL, DynamoDB, D1, Firestore, Supabase, MongoDB, Drizzle, Kysely,
Prisma, Standalone, mock, and in-memory implementations to schema `1.0.0`.
Managed AWS, Cloudflare, and Firebase deployments place Release catalogs behind
their supported pre-origin cache, while Supabase uses its direct Edge Function
URL as a supported origin-only mode and reports Edge invocations separately
from Postgres catalog reads.
