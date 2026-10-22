# React Native 0.74 example

A bare React Native 0.74 app on the old architecture (Metro, CocoaPods). The
Android Integration workflow builds it, and it is an E2E target
(`pnpm -w e2e -- --target v0.74.1`, see
[targets](../../e2e/README.md#targets)): it runs the shared
[`@examples/e2e-app`](../e2e-app).

Native libraries are pinned to the newest versions that support React Native
0.74 on the old architecture: `react-native-screens` 4.8.0 (4.9 needs 0.76)
and `react-native-safe-area-context` 5.5.2 (5.10 uses Android Gradle Plugin
APIs 0.74's does not have).

React Native 0.74's native libraries are aligned to 4 KB pages, so Android E2E
needs a 4 KB device (`android.pageSize` in `e2e.json`), such as an emulator on
`system-images;android-35;google_apis;arm64-v8a`. A 16 KB device runs the app
behind Android's page size compatibility dialog.
