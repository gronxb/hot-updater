---
"@hot-updater/plugin-insights": patch
---

Keep Insights reporting in a session that doesn't reload for a forced update, such as with `reloadOnForceUpdate: false` or a forced check that isn't installed. Reports now wait only from the moment the forced bundle is staged, and go out after 10 seconds if no reload came.
