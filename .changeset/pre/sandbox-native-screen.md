---
"@hot-updater/react-native": patch
"@hot-updater/android-helper": patch
---

The sandbox screen is native and shares one design on both platforms: SwiftUI on iOS 16 and later, and Jetpack Compose on Android, set in Geist. Expanding and collapsing rows animate smoothly, and the screen keeps its state across folds and rotations. A wide window, such as an open foldable, shows Home and Info side by side, away from the fold. Android gets edge-to-edge drawing and predictive Back. All of it ships only in sandbox builds.
