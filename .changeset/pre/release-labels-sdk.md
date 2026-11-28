---
"@hot-updater/protocol": patch
"@hot-updater/react-native": patch
---

feat(react-native): the app can show the label of the release it runs.

- `hotUpdater.getReleaseLabel()` returns the label of the release the app runs, such as `12` for `v12`, or `null` for the built-in bundle and a release without one. Native keeps it with the installed bundle, so it reads the same after a restart and offline. The native `HotUpdaterInstance` has `getReleaseLabel()` too, and its update has `label`.
- `checkForUpdate()`'s result has `label`, the label of the release it offers.
- Older servers send no labels, and the getters return `null`. An app on native code from an earlier SDK also gets `null`; nothing else changes for it.
