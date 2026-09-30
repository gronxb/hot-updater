---
"@hot-updater/react-native": minor
---

Add `@hot-updater/react-native/client-plugin`, which exports `defineClientPlugin` and the types of a client plugin's context, hooks, and their payloads. It loads neither React Native nor the native module. A plugin package imports from it, so the plugin's tests run in plain Node with `@hot-updater/test-utils/react-native`, and Metro resolves it in the app. The root entry still exports the same names for app code.
