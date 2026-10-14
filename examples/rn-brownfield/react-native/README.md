# rn-brownfield / react-native

The React Native app of the brownfield example, created with
`npm create rock` and the `brownfield-ios` and `brownfield-android` plugins.
See [`../README.md`](../README.md) for the end-to-end flow.

- `App.tsx` is registered as `RnBrownfield` in `index.js`; both hosts render
  that module name.
- `android/rnbrownfieldreact/` is the library module the
  `com.callstack.react.brownfield` Gradle plugin turns into a fat AAR
  (`com.rnbrownfieldreact:rnbrownfield:0.0.1-local`). `ReactNativeHostManager`
  there is what a host calls to start React Native.
- `ios/RnBrownfieldReact/` is the framework target that becomes
  `RnBrownfieldReact.xcframework`; it re-exports `ReactBrownfield` and exposes
  `ReactNativeBundle`.

```sh
pnpm publish-local:aar   # Release AAR -> ~/.m2/repository
pnpm package:ios         # XCFrameworks -> .rock/cache/ios/package/
pnpm start               # Metro, for `pnpm ios` / `pnpm android` standalone runs
```

## pnpm notes

The Gradle plugin, codegen, and Hermes compiler are looked up directly under
this project's `node_modules`, so `@react-native/gradle-plugin`,
`@react-native/codegen`, and `hermes-compiler` are explicit dev dependencies
here, pinned to the versions React Native 0.86 ships with. `metro.config.js`
watches the monorepo root, where pnpm keeps the real package files.
