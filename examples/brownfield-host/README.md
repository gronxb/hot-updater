# Brownfield host apps

Native iOS and Android apps for the E2E brownfield track
([`e2e/README.md`](../../e2e/README.md#brownfield-track)). They embed
`examples/v0.85.0` packaged as an XCFramework and an AAR, following the
[brownfield guide](../../docs/content/docs/(latest)/guides/brownfield.mdx), and
show its React Native root on every launch.

They reuse the example's bundle ID, package, display name, version, deep-link
scheme, and Android signing key, so the shared scenarios run unchanged and the
host installs over the example app.

```sh
pnpm -w e2e:build -- --platform ios --track brownfield
pnpm -w e2e:build -- --platform android --track brownfield
```

- iOS: `ios/project.yml` generates `HotUpdaterExampleHost.xcodeproj`
  (`xcodegen generate`); the generated project is committed. It links the
  XCFrameworks from `examples/v0.85.0/ios/.brownfield/package/build`.
- Android: `android/settings.gradle.kts` resolves the AAR from
  `examples/v0.85.0/android/brownfieldlib/build/maven`.
