# rn-brownfield / ios

Minimal native iOS host for the brownfield example. It has no React Native
tooling of its own: `BrownfieldHost.xcodeproj` links the `RnBrownfieldReact`
product of the local Swift package in `frameworks/`, whose binary targets are
the XCFrameworks that `pnpm package:ios` in `../react-native` emits.

- `pnpm frameworks` copies them from
  `../react-native/.rock/cache/ios/package/` into `frameworks/` (gitignored).
- `AppDelegate.swift` sets `ReactNativeBrownfield.shared.bundle = ReactNativeBundle`
  and `bundleURLOverride = makeHotUpdaterBundleURLOverride()` (both exported by
  the XCFramework; the override returns the bundle Hot Updater downloaded, or
  the embedded one), starts React Native, and installs a
  `UINavigationController` (navigation bar hidden) whose root is
  `NativeViewController`. The host links nothing from Hot Updater itself: the
  SDK is compiled into `RnBrownfieldReact.framework`.
- `NativeViewController.swift` is the native screen; its button pushes a
  `ReactNativeViewController(moduleName: "RnBrownfield")`. `popToNative()` from
  JavaScript pops that controller off the navigation stack. The controller's
  view is loaded before the push: `ReactNativeViewController` installs the
  React Native view one main-queue turn after its view loads, and a controller
  pushed before that keeps showing its empty placeholder.

`frameworks/Package.swift` links `RnBrownfieldReact`, `hermesvm`, `React`, and
`ReactNativeDependencies`, but not `ReactBrownfield.xcframework`: that static
archive is already compiled into `RnBrownfieldReact.framework`, and linking it
again gives the host a second copy of every brownfield class, including a
second `ReactNativeBrownfield.shared`. The host still needs the
`ReactBrownfield` Swift module that `RnBrownfieldReact` re-exports, so the
Xcode project points `FRAMEWORK_SEARCH_PATHS` at the xcframework's slices.

```sh
pnpm frameworks       # copy the XCFrameworks next to frameworks/Package.swift
pnpm ios              # build for the simulator, install on the booted one, launch
```

Or open `BrownfieldHost.xcodeproj` in Xcode after `pnpm frameworks`.
