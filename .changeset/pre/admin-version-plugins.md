---
"@hot-updater/server": patch
---

The admin `GET /version` also lists the plugins the server runs, as `plugins`: their ids, sorted, such as `["apiKeys", "insights"]`. A console reads it to show only the features those plugins serve. The client `/version` is unchanged, so apps never learn which plugins a server runs, and a server without `insights()` still answers the Insights routes with 204 and `x-hot-updater-insights: disabled`.
