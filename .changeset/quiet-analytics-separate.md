---
"@hot-updater/analytics": minor
"@hot-updater/console": minor
"@hot-updater/react-native": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/postgres": minor
"@hot-updater/supabase": minor
---

Add Analytics as an optional server plugin with its own event row,
append-and-ordered-scan persistence contract, provider capability, routes, and
`schema.analytics` lifecycle. Analytics never falls back to the Core database
and does not install authentication or managed policy.

Cloudflare D1, Firebase, PostgreSQL, and Supabase expose explicit,
provider-owned migration and runtime paths. Public Kysely, MongoDB, and blob
adapters support explicit provider composition. Legacy Analytics 1 artifacts
are validated and migrated to schema 2. Exact Analytics 2 artifacts are
validated and adopted without rewriting the Core marker or the legacy global
version, and the Analytics marker is published last.

The Console adds the Analytics overview, bundle activity, and installation
history experiences, backed by the provider-owned Analytics capability.

React Native clients can enable automatic OTA transition reporting with
`HotUpdater.init({ analytics: true })`. App-ready transitions retain stable
installation and optional user identity across launches, and analytics
delivery failures remain warning-only so they never block application startup.
