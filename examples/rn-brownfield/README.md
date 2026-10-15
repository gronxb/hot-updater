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
pnpm --filter @examples/rn-brownfield android
```

That runs, in order:

1. `pnpm publish-local:aar` in `rn-app/`: builds the Release AAR with
   the embedded bundle and publishes every variant to `~/.m2/repository`.
2. `pnpm uninstall` in `android-app/`: removes the host from the device, so
   the new build starts from its embedded bundle (see below).
3. `pnpm android` in `android-app/`: `./gradlew :app:installRelease`, which
   builds the release APK against the AAR from `mavenLocal()` and installs
   it, then launches it.

`pnpm --filter @examples/rn-brownfield android:previous` runs only step 3,
against the AAR already published, keeping the host's data.

## iOS

```sh
pnpm --filter @examples/rn-brownfield ios
```

That runs, in order:

1. `pnpm package:ios` in `rn-app/`: `pod install`, builds the
   `RnBrownfieldReact` framework target for device and simulator, and writes
   the XCFrameworks to `rn-app/.rock/cache/ios/package/`.
2. `pnpm uninstall:sim` in `ios-app/`: removes the host from the simulator, so
   the new build starts from its embedded bundle (see below).
3. `pnpm frameworks` in `ios-app/`: copies those XCFrameworks into
   `ios-app/frameworks/` (gitignored), next to the `Package.swift` that exposes
   them as the `RnBrownfieldReact` product the app target links.
4. `pnpm ios` in `ios-app/`: builds for the simulator, installs on the booted one,
   and launches `com.hotupdater.brownfieldhost`.

`pnpm --filter @examples/rn-brownfield ios:previous` runs only steps 3 and 4,
against the XCFrameworks already packaged, keeping the host's data.

The full scripts uninstall the host first because a reinstall keeps the app's
data, including the bundles Hot Updater downloaded. Its store is keyed by
fingerprint, host version and channel, so after a native rebuild that changes
only JavaScript, the host would keep running the bundle it downloaded before,
even though the new build embeds a newer one.

To work in Xcode instead, open `ios-app/BrownfieldHost.xcodeproj` after step 3.

## Changing the React Native app

Edit `rn-app/App.tsx`, then rerun `android` or `ios` here: the hosts only
pick up a change through a repackaged artifact. The `:previous` variants
rebuild and relaunch a host without repackaging, which is what an OTA test
needs after `pnpm deploy:android` / `pnpm deploy:ios` in `rn-app/`: a native
rebuild would be newer than the deployed bundle, and the SDK skips bundles
older than the build. Run `pnpm start` and `pnpm ios` / `pnpm android` in
`rn-app/` to iterate on the React Native app on its own, outside the hosts.

## Hot Updater

`rn-app/` integrates `@hot-updater/react-native` with Supabase, so the
hosts receive OTA updates for the embedded bundle. The React Native screen's
second card shows the running bundle, channel, fingerprint, and update
progress, with a Reload button. Setup, deploy commands, and what differs from
a standalone app are in [`rn-app/README.md`](rn-app/README.md).
Hot Updater reads the server URL and client API key from `.env.hotupdater` in
`rn-app/` when the artifacts are packaged, so configure it before the
demo scripts.
