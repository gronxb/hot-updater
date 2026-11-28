---
"@hot-updater/react-native": patch
---

In a sandbox build, a Downloaded bundle running from its row now reports its release ID, the bundle ID its row, the Console, and pull request comments show, to `HotUpdater.getBundleId()`, instead of its files' ID. The session's update checks are unaffected, and a row listed before releases were kept still reports its files' ID. The running row also shows the bundle's deploy message, and a sandbox link now asks **Open latest on `<channel>`?** with **Open latest**. Normal builds are unchanged.
