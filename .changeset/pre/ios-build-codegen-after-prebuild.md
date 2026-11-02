---
"@hot-updater/apple-helper": patch
---

`hot-updater native-build ios` with `installPods: true` builds an app whose `ios/` was just generated, such as an Expo app after the adapter's `expo prebuild`. From React Native 0.79, the `RCT_IGNORE_PODS_DEPRECATION=1` that `pod install` ran with also skipped its codegen, so without an earlier `ios/build/generated` it failed with `No podspec found for ReactAppDependencyProvider`. Codegen now runs before `pod install`, as the React Native CLI does, unless `RCT_SKIP_CODEGEN=1` or your own `RCT_IGNORE_PODS_DEPRECATION` leaves it to you or CocoaPods. The build also picks the `.xcworkspace` that `pod install` writes, where it used to build the bare `.xcodeproj` when no workspace existed yet.
