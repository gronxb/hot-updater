---
"@hot-updater/react-native": patch
"hot-updater": patch
---

Respect more of the app's own code in a sandbox build, and report sandbox hosts correctly.

- iOS: a `backgroundColor` the app sets on its root view before **Open** now reaches the real root.
- iOS: a sandbox link no longer shows in the `urlContexts` of a scene delegate's connection options.
- `hot-updater doctor` no longer warns about `use_frameworks` on an Expo project that doesn't enable it, and treats Expo SDK 52, 54, 57 and 58 as tested.
