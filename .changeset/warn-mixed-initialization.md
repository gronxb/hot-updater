---
"@hot-updater/react-native": patch
---

Log a single error when `HotUpdater.init()` and `HotUpdater.wrap()` are used
together, with guidance to use `init()` for manual update flows or `wrap()` for
the automatic HOC flow.
