---
"@hot-updater/react-native": minor
"@hot-updater/protocol": patch
---

`HotUpdater.wrap` is removed, with its `fallbackComponent`, `onProgress`, `reloadOnForceUpdate`, and `onUpdateProcessCompleted` options and the `HotUpdaterOptions`, `HotUpdaterFallbackComponentProps`, and `RunUpdateProcessResponse` types. `HotUpdater.init` is the one way to configure the client: call it once at module scope, export the root component directly, and check for updates with `HotUpdater.checkForUpdate()`, for example when the root mounts. `useHotUpdaterStore` still reports download progress for a loading screen.
