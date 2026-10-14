# rn-brownfield / android

Minimal native Android host for the brownfield example. It has no React
Native tooling of its own: `app/build.gradle` depends on
`com.rnbrownfieldreact:rnbrownfield:0.0.1-local`, which
`pnpm publish-local:aar` in `../react-native` publishes to `~/.m2/repository`,
and `settings.gradle` resolves that group from `mavenLocal()`.

- `MainApplication` calls `ReactNativeHostManager.initialize(this)` once.
- `MainActivity` sets `ReactNativeBrownfield.shared.createView(this, "RnBrownfield", ...)`
  as its content view.

```sh
pnpm build            # ./gradlew :app:assembleRelease
pnpm android          # install the release APK on the connected device and launch it
```

Release is the variant to use: the release AAR embeds the JS bundle, the debug
AAR expects Metro. The release build is signed with the debug keystore so it
installs on an emulator.
