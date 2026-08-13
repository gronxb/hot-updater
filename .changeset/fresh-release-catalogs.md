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
policy changes ahead of time into deterministic, bounded Release catalogs.
Database plugins now expose Release and catalog models plus atomic Release
revision/catalog generation expectations, and no longer expose provider update
decision queries.

Add canonical v2 Release-catalog and Bundle-artifact routes, short-lived
authenticated shared caching, the legacy response bridge, Release management
commands, catalog preflight/rebuild tooling, and Releases/Artifacts Console
views. Deploy, promote, rollback, rollout, targeting, enablement, and messages
now mutate Releases while patch, manifest, signing, and storage behavior remain
Bundle-keyed.

React Native clients select desired Releases locally, persist authority/scope
generation high-water and full Release/Bundle receipts, support same-Bundle
adoption and explicit EMBEDDED/BUILTIN transitions, and use generation/context
CAS so stale artifact work cannot commit. Analytics events now carry
directional Release identity alongside Bundle identity.

Migrate SQL, DynamoDB, D1, Firestore, Supabase, MongoDB, Drizzle, Kysely,
Prisma, Standalone, mock, and in-memory implementations to schema `1.0.0`.
Managed AWS, Cloudflare, and Firebase deployments place Release catalogs behind
their supported pre-origin cache, while Supabase accepts an explicit external
catalog CDN endpoint and reports direct Edge Function URLs as correctness-only.
