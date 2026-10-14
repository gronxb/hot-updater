# rn-brownfield / react-native

The React Native app of the brownfield example, created with
`npm create rock` and the `brownfield-ios` and `brownfield-android` plugins.
See [`../README.md`](../README.md) for the end-to-end flow.

- `App.tsx` is registered as `RnBrownfield` in `index.js`; both hosts render
  that module name. Its "Back to native" button calls
  `ReactNativeBrownfield.popToNative(true)`. The screen shows two cards from
  `src/components/`: `NativeHostCard` (which host opened the screen) and
  `HotUpdaterCard` (bundle id, channel, fingerprint, update progress, and a
  Reload button). `App.tsx` wraps the screen with `hotUpdater.wrap()`, which
  checks for an update on mount.
- `src/hotUpdater.ts` is the `HotUpdater.init()` instance. It reads the server
  URL and client API key from `src/hotUpdaterBuildConfig.js`, which
  `hot-updater-build-config.cjs` generates from the environment or
  `.env.hotupdater` whenever Metro loads `metro.config.js`.
- `android/rnbrownfieldreact/` is the library module the
  `com.callstack.react.brownfield` Gradle plugin turns into a fat AAR
  (`com.rnbrownfieldreact:rnbrownfield:0.0.1-local`). `ReactNativeHostManager`
  there is what a host calls to start React Native.
- `ios/RnBrownfieldReact/` is the framework target that becomes
  `RnBrownfieldReact.xcframework`; it re-exports `ReactBrownfield` and exposes
  `ReactNativeBundle` and `makeHotUpdaterBundleURLOverride()`.

```sh
pnpm publish-local:aar   # Release AAR -> ~/.m2/repository
pnpm package:ios         # XCFrameworks -> .rock/cache/ios/package/
pnpm start               # Metro, for `pnpm ios` / `pnpm android` standalone runs
pnpm fingerprint         # hot-updater fingerprint create
pnpm channel <name>      # hot-updater channel set <name>
pnpm deploy:android      # hot-updater deploy -p android -i
pnpm deploy:ios          # hot-updater deploy -p ios -i
pnpm console             # hot-updater console
```

## Hot Updater

`hot-updater.config.ts` uses the `rock` build adapter and Supabase for storage
and the database, with the `fingerprint` update strategy. Set it up once:

1. Run `npx hot-updater init` here and pick Supabase, or copy
   `.env.hotupdater.example` to `.env.hotupdater` and fill it in. The CLI reads
   that file; it is gitignored and never bundled.
2. Run `pnpm fingerprint` after any native change (it also runs on deploy),
   and `pnpm channel <name>` to pick the channel the artifact embeds.
3. Package the artifacts and rebuild the hosts (`pnpm demo:android` /
   `pnpm demo:ios` in `..`).
4. Change the app, then `pnpm deploy:android` / `pnpm deploy:ios`. The hosts
   download the bundle on their next launch of the React Native screen.

### What is brownfield-specific

Hot Updater normally reads its fingerprint and channel from the app's own
`AndroidManifest.xml` and `Info.plist`, and the app's `MainApplication` /
`AppDelegate` asks it for the bundle to load. Here the hosts have no React
Native code, so the artifacts do that themselves:

- `platform` in `hot-updater.config.ts` points the CLI at
  `android/rnbrownfieldreact/src/main/AndroidManifest.xml` and
  `ios/RnBrownfieldReact/Info.plist`, the files that ship inside the AAR and
  the XCFramework, instead of the standalone app's files.
- Android: the library manifest is merged into the host's manifest, where the
  SDK reads the meta-data. `ReactNativeHostManager` passes
  `HotUpdater.getJSBundleFile()` as the brownfield `bundleFilePath` and calls
  `HotUpdater.setReactHost()`, so `hotUpdater.reload()` swaps the bundle on the
  brownfield ReactHost. The host needs no change.
- iOS: the SDK reads `Bundle.main`, which is the host app, so
  `RnBrownfieldReact.swift` reads the framework's Info.plist and hands the
  values to `HotUpdater.configure(...)`. `makeHotUpdaterBundleURLOverride()`
  returns a closure the host assigns to
  `ReactNativeBrownfield.shared.bundleURLOverride`; it returns
  `HotUpdater.bundleURL(bundle: ReactNativeBundle)`, the downloaded bundle or
  the one embedded in the framework.
- `android/rnbrownfieldreact/build.gradle.kts` re-declares the SDK's runtime
  dependencies as `api` and embeds its vendored brotli jar: the brownfield
  Gradle plugin embeds the SDK's classes into the AAR but not its
  `implementation` dependencies.
- The app's "App version" is the host app's version. The `fingerprint`
  strategy keys updates on the artifact's native code, so hosts can bump their
  own version without a new OTA; the SDK's download cache is still keyed by
  host version, so a new host version starts from the embedded bundle.
- The SDK skips update checks in `__DEV__`, so test OTA with the Release
  artifacts, which is what the hosts use.

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
