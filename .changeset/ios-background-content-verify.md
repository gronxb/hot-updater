---
"@hot-updater/react-native": patch
---

On iOS, content shown while the app is in the background no longer verifies a launch until the app comes to the foreground. The old architecture reports content for a root view even when the App renders nothing, so a launch without UI, such as a silent push, verified a staged bundle nobody saw.
