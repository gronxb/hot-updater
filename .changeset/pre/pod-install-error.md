---
"@hot-updater/apple-helper": patch
"@hot-updater/cli-tools": patch
---

`native-build ios` shows CocoaPods' error when `pod install` fails: its `[!]` lines and last lines, without curl's download progress, with the path to the full log in `.hot-updater/log`.
