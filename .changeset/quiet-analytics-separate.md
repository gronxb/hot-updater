---
"@hot-updater/server": minor
"@hot-updater/console": minor
"@hot-updater/react-native": minor
---

Add Analytics as a built-in `createHotUpdater` domain backed directly by the
official `database.models.analytics` port. Event ingestion, bounded aggregation,
installation search, HTTP routes, and Console views now live with the server;
there is no Analytics plugin, provider override, universal component schema, or
separate `@hot-updater/analytics` package.

Runtime feature switches now share `createHotUpdater({ features: { ... } })`;
the former top-level `analytics` and `routes` options are removed.

Database providers own the physical `bundle_events` table through the shared
database contract and schema version.
`createHotUpdater({ features: { analytics: { queryAccess } } })` opts into the
routes, with queries failing closed by default.

React Native clients can enable automatic OTA transition reporting with
`HotUpdater.init({ analytics: true })`. App-ready transitions retain stable
installation and optional user identity across launches, and analytics
delivery failures remain warning-only so they never block application startup.
