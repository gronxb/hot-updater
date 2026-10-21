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
