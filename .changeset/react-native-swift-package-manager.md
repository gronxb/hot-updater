---
"@hot-updater/react-native": patch
"@hot-updater/apple-helper": patch
---

`@hot-updater/react-native` ships a `Package.swift`, so React Native 0.87's experimental Swift Package Manager mode (`npx react-native spm`) autolinks it without `npx react-native spm scaffold`, which can't translate its mixed Swift and Objective-C++ sources. CocoaPods builds keep using `HotUpdater.podspec` and are unchanged.

- A build tool plugin runs the same script as the podspec's script phase before every build, so SwiftPM builds also ship their own build time as `MIN_BUNDLE_ID`, and a `HOT_UPDATER_MIN_BUNDLE_ID` that is not a UUIDv7 fails the build. The plugin can read only the environment, not build settings, so `hot-updater build:ios` now passes its `HOT_UPDATER_MIN_BUNDLE_ID` both ways.
- `react-native.config.js` sets `spm.name` to `HotUpdater`, which keeps `import HotUpdater` in `AppDelegate.swift` working.
