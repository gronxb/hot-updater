---
"@hot-updater/server": minor
"@hot-updater/aws": patch
---

`createEngineDatabase` takes `onCachedRoutesChange`, a CDN purge for the cacheable client routes that core calls after a committed write that changes a Release Catalog. Core decides which writes those are, so neither a provider adapter nor the storage engine names a table: `dynamoDB` passes its CloudFront invalidation there.
