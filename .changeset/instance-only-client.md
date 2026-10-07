---
"@hot-updater/react-native": minor
"@hot-updater/protocol": patch
---

`HotUpdater` keeps only `init`; every other method is on the instance it returns. Call `HotUpdater.init` once at the top level of a module, export the instance, and call `hotUpdater.checkForUpdate()`, `hotUpdater.reload()`, `hotUpdater.getBundleId()`, and the rest on it. Calling `init` again replaces the configuration for every instance.

`HotUpdater.wrap` becomes `hotUpdater.wrap`, which takes only the update flow: `updateStrategy`, `fallbackComponent`, `onProgress`, `reloadOnForceUpdate`, and `onUpdateProcessCompleted`. Move `baseURL`, `requestHeaders`, `requestTimeout`, `plugins`, `onError`, and `onNotifyAppReady` to `HotUpdater.init`. `HotUpdaterOptions` becomes `HotUpdaterWrapOptions`. `wrap` reads the launch through `init` instead of reading it again, and reloads for a forced update only after that read.
