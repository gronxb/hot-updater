---
"@hot-updater/plugin-insights": patch
---

When a forced bundle is staged, Insights no longer starts a request beside the reload. `UPDATE_DOWNLOADED` and any report still waiting stay in plugin storage and arrive first at the next launch, under their original event IDs.
