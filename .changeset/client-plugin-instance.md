---
"@hot-updater/protocol": minor
"@hot-updater/react-native": minor
"@hot-updater/plugin-insights": minor
"@hot-updater/plugin-remote-config": minor
"@hot-updater/test-utils": minor
---

`HotUpdater.init` returns the app's HotUpdater instance: HotUpdater's methods, and each client plugin's API under the plugin's id, typed from `plugins`.

- **Client plugin contract:** `setup(context)` returns `{ hooks, api }`, either of them, or nothing. `api` is what the app calls, as `hotUpdater.<id>`; a plugin id cannot be the name of an instance member, such as `reload`. A `setup` that returns hooks at the top level, as before, is reported through `onError` and gets no hooks. `ClientPluginApi`, `ClientPluginApis`, and `HotUpdaterClientSetup` type it; `HotUpdaterInstance` and `HotUpdaterCore` type the instance.
- **Insights:** `setUser` moves from the plugin object to `hotUpdater.insights.setUser`. The launch report waits for native launch verification, so a user set right after `init` is on the first report.
- **Remote Config:** the reads, `fetch`, `activate`, and `subscribe` are on `hotUpdater.remoteConfig`; the plugin object has only `id` and `setup`.
- **Tests:** `setupClientPlugin` returns the plugin's `api`, and `setupClientPlugins` the plugins' `apis` by id.
