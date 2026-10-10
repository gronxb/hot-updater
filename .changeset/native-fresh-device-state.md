---
"@hot-updater/react-native": patch
---

The native SDK starts from an empty bundle store when the device holds OTA state in another metadata schema, such as the state an app kept from before its native upgrade. On first launch it removes that state's bundles, metadata, crash history and launch report, and launches the build's built-in bundle.

- On iOS, a changed isolation key now removes the old bundles, as it already did on Android.
