# React Native 0.87 Swift Package Manager example

This app builds iOS with React Native's experimental Swift Package Manager mode
(`npx react-native spm`) instead of CocoaPods. `@hot-updater/react-native` is
autolinked through its own `Package.swift`, and every build writes its own
`MIN_BUNDLE_ID`, as CocoaPods builds do.

## iOS

```sh
pnpm install
pnpm --filter @hot-updater/react-native build
pnpm spm
```

`pnpm spm` (`cd ios && react-native spm`) plays the role of `pod install`: it
runs codegen, downloads React Native's prebuilt XCFrameworks and writes the
SwiftPM packages under `ios/build/` (gitignored). Run it after cloning and
when native dependencies change, then open `ios/HotUpdaterExample.xcodeproj`
or build it:

```sh
xcodebuild -project ios/HotUpdaterExample.xcodeproj -scheme HotUpdaterExample \
  -configuration Release -sdk iphonesimulator
```

The app shows the `MIN_BUNDLE_ID` this build shipped and the time it encodes.

## Deploy

Fill in `.env.hotupdater` (see `hot-updater.config.ts`), then:

```sh
pnpm hot-updater deploy -p ios
```
