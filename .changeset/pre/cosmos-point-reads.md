---
"@hot-updater/azure": patch
---

perf(azure): read one or two Cosmos DB items by point reads instead of a query, such as the release catalog on every update check. On Strong consistency a point read costs 2 RU and a one-id query 5.9 RU.
