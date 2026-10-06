---
"@hot-updater/react-native": patch
---

Keep a pending bundle when a launch never shows UI. An Android headless JS task, such as a background push message, and an iOS background launch no longer record an unfinished launch, so the next launch no longer rolls a healthy bundle back, adds it to crash history, and reports `RECOVERED`. A launch is recorded when an activity starts on Android, and when the app is in the foreground on iOS. Requires rebuilding the native app.
