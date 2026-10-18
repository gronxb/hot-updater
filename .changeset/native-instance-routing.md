---
"@hot-updater/react-native": patch
---

`HotUpdater` in JavaScript works with the native instance whose bundle its React Native runtime runs, with no change to the JavaScript API.
- A runtime that runs a bundle a named instance handed out, or a bundle inside that name's storage, uses that name's bundle ID, channel, fingerprint, stored values, Release catalog state, queued native events, update checks, downloads, and `notifyAppReady`. Every other runtime, including one served by Metro, uses `main` as before.
- Download progress reaches only the runtime of the instance that downloads.
- `HotUpdater.reload()` and `HotUpdater.reloadProcess()` reject with `RELOAD_UNSUPPORTED` in the runtime of a named instance, instead of reloading main's React Native host or the whole app. Reload that runtime's React Native host from native code.
