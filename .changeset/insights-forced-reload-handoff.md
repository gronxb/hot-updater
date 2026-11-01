---
"@hot-updater/plugin-insights": patch
---

During a forced update, Insights no longer starts a request beside the reload. Its reports wait in plugin storage and arrive first at the next launch, under their original event IDs. If the forced update fails, no reload follows, so they are sent at once.
