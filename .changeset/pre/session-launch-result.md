---
"@hot-updater/react-native": patch
---

Keep a session's launch result final when an update downloads during that session. A root wrapped with `HotUpdater.wrap` that mounts again in the same process, for example after Android recreates its activity, no longer stays on its `fallbackComponent` waiting for the downloaded bundle, and `onNotifyAppReady` is called again with `UNCHANGED`. The next launch still applies the downloaded bundle. Requires rebuilding the native app.
