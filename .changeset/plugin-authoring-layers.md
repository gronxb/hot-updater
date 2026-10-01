---
"@hot-updater/plugin-core": minor
"@hot-updater/protocol": minor
"@hot-updater/server": patch
"@hot-updater/react-native": patch
---

The plugin authoring APIs move below the packages that run plugins, so a plugin package needs neither `@hot-updater/server` nor `@hot-updater/react-native` to build:

- `@hot-updater/plugin-core` exports `definePlugin` and its types, the schema DSL, the typed database handle, the database errors, `isDatabaseBusyError`, `HotUpdaterConfigError`, and `CoreReads`, now an explicit interface of core's reads. `@hot-updater/server/plugins` and `@hot-updater/server/database` export the same names as before.
- `@hot-updater/protocol` exports the client plugin contract: `defineClientPlugin` and its hook and context types. `@hot-updater/react-native` exports the same names as before.
