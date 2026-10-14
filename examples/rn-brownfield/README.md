# React Native brownfield example

Three projects that mirror a brownfield setup: a React Native app that is
packaged into native artifacts, and two native apps that embed them.

| Folder          | What it is                                                                 |
| --------------- | -------------------------------------------------------------------------- |
| `rn-app/`       | A [Rock](https://rockjs.dev) app with the brownfield plugins. `rock package:aar` builds the `rnbrownfieldreact` AAR and `rock package:ios` builds the `RnBrownfieldReact` XCFramework. |
| `android-app/`  | A plain Gradle app that depends on `com.rnbrownfieldreact:rnbrownfield:0.0.1-local` from the local Maven repository. Its native screen opens the `RnBrownfield` component in a second Activity. |
| `ios-app/`      | A plain Xcode app that links the XCFrameworks through a local Swift package in `ios-app/frameworks/`. Its native screen pushes the `RnBrownfield` component onto a navigation stack. |

Both hosts show the same flow: a native card ("Hello from iOS Native" /
"Hello from Android Native") with an "Open React Native" button, which opens
the React Native screen full-screen. That screen has a "Back to native" button
that calls `popToNative()` from `@callstack/react-native-brownfield`, which
pops the UIKit navigation stack on iOS and finishes the Activity on Android.

The React Native side uses [`@callstack/react-native-brownfield`](https://oss.callstack.com/react-native-brownfield/):
`ReactNativeHostManager` (Android) and `ReactNativeBundle` (iOS) ship inside
the artifacts, and the hosts call `ReactNativeBrownfield.shared` to create the
React Native view. The hosts always use the Release artifacts: those embed the
JS bundle, while Debug artifacts expect a Metro dev server.

## Prerequisites

- The repository's `pnpm install`.
- Android: an SDK with API 36 and a running emulator or device.
- iOS: Xcode, CocoaPods, and a booted simulator (`xcrun simctl boot "iPhone 17"`).

## Android

```sh
pnpm --filter @examples/rn-brownfield demo:android
```

That runs, in order:

1. `pnpm publish-local:aar` in `rn-app/`: builds the Release AAR with
   the embedded bundle and publishes every variant to `~/.m2/repository`.
2. `pnpm build` in `android-app/`: `./gradlew :app:assembleRelease`, resolving the
   AAR from `mavenLocal()`.
3. `pnpm android` in `android-app/`: installs the release APK and launches it.

## iOS

```sh
pnpm --filter @examples/rn-brownfield demo:ios
```

That runs, in order:

1. `pnpm package:ios` in `rn-app/`: `pod install`, builds the
   `RnBrownfieldReact` framework target for device and simulator, and writes
   the XCFrameworks to `rn-app/.rock/cache/ios/package/`.
2. `pnpm frameworks` in `ios-app/`: copies those XCFrameworks into
   `ios-app/frameworks/` (gitignored), next to the `Package.swift` that exposes
   them as the `RnBrownfieldReact` product the app target links.
3. `pnpm ios` in `ios-app/`: builds for the simulator, installs on the booted one,
   and launches `com.hotupdater.brownfieldhost`.

To work in Xcode instead, open `ios-app/BrownfieldHost.xcodeproj` after step 2.

## Changing the React Native app

Edit `rn-app/App.tsx`, then rerun the demo script for the platform you
want: the hosts only pick up a change through a repackaged artifact. Run
`pnpm start` and `pnpm ios` / `pnpm android` in `rn-app/` to iterate on
the React Native app on its own, outside the hosts.

## Hot Updater

`rn-app/` integrates `@hot-updater/react-native` with Supabase, so the
hosts receive OTA updates for the embedded bundle. The React Native screen's
second card shows the running bundle, channel, fingerprint, and update
progress, with a Reload button. Setup, deploy commands, and what differs from
a standalone app are in [`rn-app/README.md`](rn-app/README.md).
Hot Updater reads the server URL and client API key from `.env.hotupdater` in
`rn-app/` when the artifacts are packaged, so configure it before the
demo scripts.
