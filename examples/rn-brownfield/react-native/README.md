# rn-brownfield / react-native

The React Native app of the brownfield example, created with
`npm create rock` and the `brownfield-ios` and `brownfield-android` plugins.
See [`../README.md`](../README.md) for the end-to-end flow.

- `App.tsx` is registered as `RnBrownfield` in `index.js`; both hosts render
  that module name. Its "Back to native" button calls
  `ReactNativeBrownfield.popToNative(true)`.
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

`metro.config.js` also forces `react` and `react-native` to resolve to this
project's copies. `@callstack/react-native-brownfield` has no `react-native`
peer dependency, so from inside its package directory Metro would otherwise
walk up to pnpm's hidden hoist directory (`node_modules/.pnpm/node_modules`),
which holds whichever React Native version another workspace package pulled
in. Two React Native copies in one bundle make every TurboModule lookup fail
at startup with "'ReactNativeBrownfield' could not be found".

## Gradle note

`android/rnbrownfieldreact/build.gradle.kts` deletes the library's merged
assets and resources before every merge. The brownfield Gradle plugin feeds
the JS bundle from `app/build/generated` into the library's source sets, but
Gradle does not track that directory as a task input, so without this a
changed `App.tsx` would be bundled and then silently left out of the AAR.
