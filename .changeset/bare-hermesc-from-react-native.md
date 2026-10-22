---
"@hot-updater/bare": patch
---

Compile with the Hermes the app's React Native ships. A React Native before 0.83 bundles hermesc and has no `hermes-compiler` dependency, but `hermes-compiler` from another app in the workspace, such as one pnpm hoists, was reachable from it. The OTA bundle then held bytecode the app's Hermes refused to load ("Wrong bytecode version. Expected 96 but got 98").
