---
"@hot-updater/plugin-insights": patch
---

Keep Insights reporting in a session that doesn't reload for a forced update, such as with `reloadOnForceUpdate: false` or a forced check that isn't installed. Only the reports present when a forced bundle is staged wait for the next launch; later reports send as usual.
