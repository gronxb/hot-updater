---
"@hot-updater/server": patch
---

Core's database holds only core's tables. The plugins a server runs bring theirs, `insights()` and `apiKeys()` included, and core serves no Insights route.

- **Schema:** `@hot-updater/server/database` exports `coreSchema`, `coreSettings`, and `coreTarget`, core's tables, settings rows, and tooling target; `toolingTargetOf(plugins)`, the target of core with those plugins; and `migrateCoreSchema(adapter, name, plugins?)`, which creates core's tables and those of `plugins`, then writes their settings rows. `createEngineDatabase` checks core's settings rows, and a server also checks those of the plugins it runs.
- **Tooling:** `hot-updater db migrate` and `db generate` create core's tables and those of the server's `plugins`. A server without `insights()` or `apiKeys()` has no Insights or API key tables.
- **Plugin tables:** `definePlugin` takes `namespace: false`, which keeps the declared table names instead of prefixing them with the plugin's id. Such a plugin owns collisions, which startup checks against core's tables and those of the other plugins the server runs, and only such a plugin may take a camelCase id. `insights()` and `apiKeys()` set it, so their tables and settings rows keep their names. A plugin's id and tables need to be free only of core's and of the other plugins the server runs.
- **Insights routes:** without `insights()`, `POST /events` and the admin Insights reads are not mounted and answer `404`. The React Native Insights plugin then pauses reporting.
