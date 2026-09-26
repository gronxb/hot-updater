---
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
---

Add plugins to `createHotUpdater`. The new `@hot-updater/server/plugins` subpath exports `definePlugin`, `defineTable`, and `defineAggregate`. A plugin declares its tables and aggregates. Its `init` receives a typed database handle on the storage engine and a clock, and returns its API, its endpoints, and optionally `clientAuth`.

`createHotUpdater({ database, plugins, storage, clientAccess })` runs each plugin's `init` once at startup and exposes each API as `hotUpdater.api.<id>`. Endpoints mount on `handlers.client`, behind the client-route policy, or on `handlers.admin`.

Client routes have one policy source: exactly one plugin that provides `clientAuth`, or `clientAccess: "public"`. The types count clientAuth plugins in a tuple and name the fix. Startup throws `HotUpdaterConfigError` for any of these:

- duplicate plugin ids
- a `kind` key or other unknown keys
- an async `init`
- a `provides.clientAuth` that disagrees with the instance
- colliding routes
- a database that is not on the storage engine

Cacheable client responses vary by the policy's headers, so public servers now send `Vary: Accept-Encoding` alone.

`@hot-updater/test-utils` adds `createPluginTestHarness`, which runs one plugin on a memory adapter in verify mode, with `measureReads`.
