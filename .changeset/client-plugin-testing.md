---
"@hot-updater/test-utils": minor
---

Add `@hot-updater/test-utils/react-native` for testing client plugins. `setupClientPlugin(plugin, options)` and `setupClientPlugins(plugins, options)` set plugins up on the plugin host `@hot-updater/react-native` runs them on in an app, as `HotUpdater.init` does, so plugin ids are checked the same way. They return:

- `hooks`: `onAppReady`, `onUpdateCheck`, `onBundleDownloaded`, and `onUpdateError`, called as the SDK calls them: the call doesn't wait for the hook, and a throw or rejection lands in `errors` instead of being raised.
- `requests`: what plugins sent with `context.fetch`, with `requestHeaders` applied. The test's `respond` handler answers each request, or it gets `204 No Content`.
- `storage`: each plugin's in-memory storage, scoped by plugin id and capped at 64 KB as on a device. Pass it to the next setup, or seed one from `createTestStorage()`, to start the plugins again on the same device.
- `settled()`, which waits for the hooks called so far and the requests they started.

The device's values (install id, platform, app version, bundle, channel, cohort, fingerprint hash, and clock) have fixed defaults, and a test can set each one. The subpath ships as ESM and CommonJS and loads neither React Native nor Vitest, so plugin tests run in plain Node under Vitest or Jest. `@hot-updater/react-native` is an optional peer dependency that only this subpath needs.
