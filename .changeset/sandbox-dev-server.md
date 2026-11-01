---
"hot-updater": minor
"@hot-updater/android-helper": minor
"@hot-updater/apple-helper": minor
"@hot-updater/react-native": minor
---

A sandbox build can run JavaScript from a dev server. Enter its address on the first screen; `reload()` stays on it, a crash ends it, and only **Exit** returns to your app's bundle. Dev JavaScript's update checks, `updateBundle`, `resetChannel` and launch reports leave the selected bundle's state as it was, and its crash is never held against a bundle. See the Sandbox builds guide.

- Android: a sandbox build compiles a generated `HotUpdaterImpl` from the source it packages, in place of the original, and refuses a source it doesn't recognize. A normal build's compile inputs don't change. It refuses an app that takes the SDK as a prebuilt AAR, and the Rock adapter on Android.
- iOS: the sandbox template overrides `HotUpdaterImpl`'s bridge-facing methods, with no change to a normal build's sources. A sandbox archive allows local networking.
- `@hot-updater/react-native` gets no new API, no new bridge method, and no change to any source a normal build compiles.
