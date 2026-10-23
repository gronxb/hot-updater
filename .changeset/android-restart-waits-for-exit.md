---
"@hot-updater/react-native": patch
---

On Android, a restart (`reload()` or crash recovery) waits for the old process to exit before it starts the app again, for up to 2 seconds. An app started while the system still had the old process registered could be handed to that process and lost with it, which left the app closed instead of restarted.
