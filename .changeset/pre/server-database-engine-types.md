---
"@hot-updater/plugin-core": patch
---

`@hot-updater/plugin-core` exports the `EngineDatabase` type that a database provider returns and the `AggregateBatching` type of its `aggregateBatching` option. A database adapter imports everything it needs from `@hot-updater/plugin-core` and lists only it in `peerDependencies`.
