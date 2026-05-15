---
"@hot-updater/react-native": patch
---

feat(react-native): support dynamic `baseURL` resolvers for `HotUpdater.init`
and `HotUpdater.wrap`

`baseURL` can now be a string or a function returning a string or promise. The
default resolver calls the function before each update check so apps can resolve
the update server URL at runtime.
