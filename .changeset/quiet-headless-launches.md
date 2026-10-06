---
"@hot-updater/react-native": patch
---

Keep a pending bundle when a launch never shows UI. An Android headless JS task, such as a background push message, and an iOS background launch no longer record an unfinished launch, so the next launch no longer rolls a healthy bundle back and reports `RECOVERED`. A launch is recorded once an activity has started on Android, including one that was on screen before React Native loaded, and when the app is in the foreground on iOS. Requires rebuilding the native app.
