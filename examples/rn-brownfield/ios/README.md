# rn-brownfield / ios

Minimal native iOS host for the brownfield example. It has no React Native
tooling of its own: `BrownfieldHost.xcodeproj` links the `RnBrownfieldReact`
product of the local Swift package in `frameworks/`, whose binary targets are
the XCFrameworks that `pnpm package:ios` in `../react-native` emits.

- `pnpm frameworks` copies them from
  `../react-native/.rock/cache/ios/package/` into `frameworks/` (gitignored).
- `AppDelegate.swift` sets `ReactNativeBrownfield.shared.bundle = ReactNativeBundle`,
  starts React Native, and shows a `ReactNativeViewController(moduleName: "RnBrownfield")`.

```sh
pnpm frameworks       # copy the XCFrameworks next to frameworks/Package.swift
pnpm ios              # build for the simulator, install on the booted one, launch
```

Or open `BrownfieldHost.xcodeproj` in Xcode after `pnpm frameworks`.
