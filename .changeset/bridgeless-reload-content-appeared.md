---
"@hot-updater/react-native": patch
---

Keep an update applied by an in-process reload on Android's New Architecture (Bridgeless). React Native's `ReactHost.reload()` restarts the surfaces it already has, which never log first content again, so a bundle applied with `setReloadBehavior("reload")`, or by the in-process fallback when a process restart cannot start, stayed unverified and the next cold start rolled it back. Hot Updater now lets those surfaces log first content again once the new React instance exists, so the reloaded bundle is verified in the same session.
