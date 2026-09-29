---
"@hot-updater/react-native": patch
---

Stop re-rendering the wrapped app on download progress updates. `HotUpdater.wrap` now subscribes to progress only inside the fallback component and the `onProgress` reporter.
