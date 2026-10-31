---
"@hot-updater/react-native": minor
---

Add `hotUpdater.getUpdateStatus()`, `getUpdateLogs()`, and `clearUpdateLogs()` for in-app diagnostics screens. The status says whether over-the-air updates are on in this build, whether the next restart runs another bundle, and the running bundle, channel, app version, fingerprint, and minimum bundle ID. The log holds this device's checks, downloads, applied updates, rollbacks, and crash recoveries, newest 200 entries of the last 7 days, and never leaves the device. On native built from an earlier SDK, `isUpdatePending` and `getUpdateLogs()` resolve with `null`. A native `HotUpdaterInstance` has the same three methods.
