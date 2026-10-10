---
"@hot-updater/react-native": patch
---

The native SDK reads only bundle metadata written in its own schema. A device whose metadata is in another schema launches the build's built-in bundle, and its next update replaces that metadata.

- On iOS, a changed isolation key now removes the old bundles, as it already did on Android.
