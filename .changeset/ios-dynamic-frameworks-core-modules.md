---
"@hot-updater/react-native": patch
---

fix(ios): the `HotUpdater` pod links with `use_frameworks! :linkage => :dynamic` again: it looks up `RCTExceptionsManager` at runtime instead of linking against `React-CoreModules` (#1729)
