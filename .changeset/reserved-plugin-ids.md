---
"@hot-updater/server": patch
"@hot-updater/console": patch
---

The plugin ids `insights` and `apiKeys` belong to Hot Updater's `insights()` and `apiKeys()`, even when a server doesn't run them. `createHotUpdater` refuses any other plugin that takes one of these ids with `HotUpdaterConfigError`, including a copy such as `{ ...insights() }`, so the tooling that reads a server's plugins (plugin commands, the client credential, and client plugins) reads Hot Updater's own. The console serves a feature only through Hot Updater's own plugin.
