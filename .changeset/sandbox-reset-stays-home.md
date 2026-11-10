---
"@hot-updater/react-native": patch
---

The sandbox's **Reset to built-in bundle**, on the Info tab and on a crash banner, no longer runs the built-in bundle right away. The sandbox screen stays up and shows Home, whose row reads **Open built-in bundle** and runs it when tapped, also over a running app that still runs another bundle.

`resetChannel()`, and an update check that selects the built-in bundle, keep the files of the bundle the app runs, so its images still load until the app reloads; the next launch removes them. Until then `HotUpdater.getBaseURL()`, `getManifest()`, and the native bundle ID keep describing the running bundle, so Expo DOM components keep loading its content.
