---
"@hot-updater/react-native": patch
"@hot-updater/protocol": patch
---

Every "bundle ID" the SDK shows is now the release ID, the ID the Console shows and `hotUpdater.getBundleId()` returns:

- The native instance's `getBundleId()` (iOS `HotUpdaterInstance`, Android `HotUpdaterInstance`) returns the ID of the release the launch runs. For the built-in bundle it returns `MIN_BUNDLE_ID`. It returns the artifact ID only for a bundle installed without a release, and `nil`/`null` before the launch's bundle is read. Before, it returned the artifact ID, and `nil` for the built-in bundle.
- A client plugin's `context.getBundleId()` returns the same value as `hotUpdater.getBundleId()`. Before, it returned the artifact ID. A plugin that needs the artifact reads the hooks' `bundleId`, `fromBundleId`, `toBundleId`, and `targetBundleId`.
- The sandbox screen names every bundle by its release ID, as its Downloaded rows already did: the big row, Running and Next launch, the crash banner, and Info's Current and Pending. A crashed bundle whose release the device no longer knows is named by its artifact ID.

The TurboModule's methods and parameters are unchanged.
