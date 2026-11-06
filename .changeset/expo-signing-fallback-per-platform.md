---
"hot-updater": patch
---

`deploy` and `doctor` read an Expo app's `publicKeyPath` for each platform that has no native files, even when a build of the other platform generated its own. Before, an Expo project whose `android/` folder a sandbox build had just generated failed `deploy -p ios` with "Signing is enabled but @hot-updater/expo publicKeyPath is missing", because the Expo app config was read only when both `ios/` and `android/` were missing.
