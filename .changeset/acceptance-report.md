---
"@hot-updater/server": minor
"@hot-updater/aws": patch
---

`createEngineDatabase` takes `onCachedRoutesChange`, called after a committed write that changes what the cacheable client routes answer: a Release Catalog row, while a check op changes nothing. The server decides which tables that is, so a provider adapter names no table: `dynamoDB` passes its CloudFront invalidation there.
