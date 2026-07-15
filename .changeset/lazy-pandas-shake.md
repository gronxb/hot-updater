---
"@hot-updater/react-native": patch
---

Coalesce progress store notifications on a short trailing timer to prevent "Maximum update depth exceeded" crashes on Fabric/bridgeless Android when native emits rapid bursts of distinct progress events during a bundle download. State updates remain synchronous — only subscriber notification is deferred.
