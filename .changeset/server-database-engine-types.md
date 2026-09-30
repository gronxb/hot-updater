---
"@hot-updater/server": patch
---

`@hot-updater/server/database` exports the `EngineDatabase` type that a database provider returns and the `AggregateBatching` type of its `aggregateBatching` option. A database adapter imports everything it needs from `@hot-updater/server/database` and lists only `@hot-updater/server` in `peerDependencies`.
