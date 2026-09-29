---
"@hot-updater/server": patch
"@hot-updater/aws": patch
---

DynamoDB no longer reads the item at a range's exclusive upper bound. The key-value helper now gives each range an inclusive form of its upper bound that admits exactly the keys below it, and the DynamoDB store uses it for `BETWEEN`, so a two-sided range reads only rows it returns.
