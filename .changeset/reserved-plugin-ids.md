---
"@hot-updater/server": patch
"@hot-updater/console": patch
---

The plugin ids `insights` and `apiKeys` belong to Hot Updater's `insights()` and `apiKeys()`, even when a server doesn't run them. `createHotUpdater`, `createDatabasePluginApis`, and the tooling that reads a server's plugins (plugin commands, the client credential, and client plugins) refuse any other plugin that takes one of these ids with `HotUpdaterConfigError`, including a copy such as `{ ...insights() }`. `isOfficialPlugin` from `@hot-updater/server/db` tells Hot Updater's own plugins apart, and the console serves a feature only through that plugin.
