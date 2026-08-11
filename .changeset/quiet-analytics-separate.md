---
"@hot-updater/analytics": minor
"@hot-updater/console": minor
"@hot-updater/react-native": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/postgres": minor
"@hot-updater/supabase": minor
"@hot-updater/cli-tools": minor
"hot-updater": minor
---

Add Analytics as an optional server plugin with its own event row,
append-and-ordered-scan persistence contract, universal component schema,
routes, and `schema.analytics` lifecycle. Analytics never falls back to the
Core database and does not install authentication or managed policy.

Cloudflare D1, Firebase, PostgreSQL, and Supabase expose provider-neutral
component data adapters and version-tagged deployment artifacts without
importing Analytics. The Analytics plugin owns its schema history, validation,
and legacy-adoption policy. Legacy Analytics 1 artifacts are validated and
migrated to schema 2. Exact Analytics 2 artifacts are validated and adopted
without rewriting the Core marker or the legacy global version, and the
Analytics marker is published last. Public Kysely, MongoDB, and blob adapters
remain available through explicit provider composition.

The Console adds the Analytics overview, bundle activity, and installation
history experiences. Provider initialization and schema generation compose the
active Analytics plugin into provider-neutral component artifacts and runtime
migrations. The Console also shows managed client access-key lifecycle controls
when a database exposes the neutral component-data adapter used by Better Auth.

React Native clients can enable automatic OTA transition reporting with
`HotUpdater.init({ analytics: true })`. App-ready transitions retain stable
installation and optional user identity across launches, and analytics
delivery failures remain warning-only so they never block application startup.
