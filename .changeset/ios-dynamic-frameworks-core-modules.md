---
"@hot-updater/react-native": patch
---

fix(ios): the `HotUpdater` pod links with `use_frameworks! :linkage => :dynamic` again: it looks up `RCTExceptionsManager` at runtime instead of linking against `React-CoreModules` (#1729). `HotUpdater.podspec` now follows the `create-react-native-library` template: it always calls `install_modules_dependencies` (React Native 0.71 and later) and takes React Native's minimum iOS version from `min_ios_version_supported`.
