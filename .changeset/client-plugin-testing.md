---
"@hot-updater/react-native": minor
---

Add `@hot-updater/react-native/testing` for testing client plugins. `setupClientPlugin(plugin, options)` and `setupClientPlugins(plugins, options)` set plugins up with the SDK's own plugin host, as `HotUpdater.init` does, so plugin ids are checked the same way, and return:

- `hooks`: `onAppReady`, `onUpdateCheck`, `onBundleDownloaded`, and `onUpdateError`, called as the SDK calls them: the call doesn't wait for the hook, and a throw or rejection lands in `errors` instead of being raised.
- `requests`: what plugins sent with `context.fetch`, with `requestHeaders` applied. The test's `respond` handler answers each request, or it gets `204 No Content`.
- `storage`: each plugin's in-memory storage, scoped by plugin id and capped at 64 KB as on a device. Pass it to the next setup, or seed one from `createTestStorage()`, to start the plugins again on the same device.
- `settled()`, which waits for the hooks called so far and the requests they started.

The device's values (install id, platform, app version, bundle, channel, cohort, fingerprint hash, and clock) have fixed defaults, and a test can set each one. The helper loads neither React Native nor the native module, so plugin tests run in plain Node with Vitest or Jest.
