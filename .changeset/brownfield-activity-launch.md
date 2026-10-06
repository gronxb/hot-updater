---
"@hot-updater/react-native": patch
---

Record a launch on Android when React Native loads inside an activity that was already started, as in a brownfield app that adds React Native to a screen on display. Android does not replay that activity start, so such a launch was never recorded, and a staged bundle that hung there was not rolled back on the next start. Requires rebuilding the native app.
