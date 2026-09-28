---
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
---

Insights event lists reach every event again. The global and bundle lists read one query per UTC day, and a page stopped at the 90th day below its cursor, so older events were unreachable once those 90 days held fewer than `limit` events. Each call still reads at most 90 days, and a short or empty page whose 90 days end after `sinceMs` now carries a cursor that resumes below them. The Insights plugin's `listEvents` rejects an interval longer than 90 days instead of cutting it short, and the read-budget suite measures a whole empty 90-day window: 90 zero-row queries.
