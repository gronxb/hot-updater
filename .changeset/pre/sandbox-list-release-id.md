---
"@hot-updater/react-native": patch
---

Name each bundle in the sandbox's Downloaded list by the ID that `HotUpdater.getBundleId()`, the PR preview comment, and the Console show: the release's ID. The list showed the ID of the stored files instead, so a row didn't match the app or the PR comment. The "Running stored" row and Info's Current row use the same ID. Bundles listed before this change keep their old ID until they're downloaded again. Only `sandbox: true` builds change.
