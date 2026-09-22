---
"@hot-updater/react-native": patch
---

Recover from an unverified OTA bundle that never reaches its first render after the app is killed. Persist native launch progress on iOS and Android and roll back on the next cold start even without a crash marker. Requires rebuilding the native app; terminating before first render counts as a failed launch.
