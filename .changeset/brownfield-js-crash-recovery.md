---
"@hot-updater/react-native": patch
---

Roll back a bundle whose JavaScript fails during startup in a brownfield app on Android, as in an app with a `ReactApplication`. Crash recovery reached the React instance only through `ReactApplication`, so in a native app that passes its host to `HotUpdater.setReactHost`, a startup JavaScript error was not routed to recovery and the app did not restart into the previous bundle. Recovery now uses the host from `HotUpdater.setReactHost` first. Requires rebuilding the native app.
