---
"@hot-updater/react-native": patch
---

A fresh sandbox build opens a preview link without a manual step. When a link waits for your update server, the sandbox starts your app under its screen, once, so the app's own update check can answer. The screen says "Checking pr-134…" and then asks to open the latest bundle. If no answer comes within a minute, such as from an app that checks only after sign-in, the screen asks you to open the app, as before.
