---
"@hot-updater/react-native": minor
---

Add opt-in `verifyOnAppReady`, which promotes a staged bundle when `notifyAppReady()` runs instead of when its first content appears, and `HotUpdater.reportBundleFailure()`, which lets an app roll back a bundle after a startup error it caught itself, such as a render error caught by an error boundary. Turn it on with the Expo plugin option, the `HOT_UPDATER_VERIFY_ON_APP_READY` Info.plist key, the `com.hotupdater.VERIFY_ON_APP_READY` manifest meta-data, or `HotUpdater.configure`. With it off, a bundle is still promoted on first content.
