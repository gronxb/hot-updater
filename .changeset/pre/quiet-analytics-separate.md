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

Runtime Analytics ingestion and query routes are always available. The former
server-side `analytics` and `routes` options are removed.

Database providers own the physical `bundle_events` table through the shared
database contract and schema version.
Event ingestion lives on `handlers.client`; queries live on
`handlers.admin` and rely on the framework middleware protecting that mount.

React Native clients can enable automatic OTA transition and Release adoption
reporting by setting `analytics: true` in either `HotUpdater.init` or
`HotUpdater.wrap`. Omitting the option or setting it to `false` sends no events.
App-ready transitions retain stable installation and optional user identity
across launches, and analytics delivery failures remain warning-only so they
never block application startup.
