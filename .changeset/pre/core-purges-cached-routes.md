---
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/aws": patch
---

Core purges a CDN's copies of the update-check routes itself. After a committed transaction that writes a Release Catalog, it calls the database's `onCachedRoutesChange`, which `EngineDatabase` now carries. The storage engine's database wrapper no longer inspects table names, and `createEngineDatabase({ onCachedRoutesChange })` only hands the purge to core, so the CLI, the console, and the server purge after the same writes. A preview, a rerun attempt, or a write that changes no catalog purges nothing.

The built-in database (`createEngineDatabase`, `builtInSchema`, `builtInSettings`, `migrateBuiltInSchema`) moves from the storage engine's directory to the `db` tooling next to it, since it binds core's and the built-in plugins' schemas; `@hot-updater/server/database` exports the same names.
