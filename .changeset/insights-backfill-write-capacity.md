---
"@hot-updater/plugin-insights": patch
"@hot-updater/plugin-core": patch
"@hot-updater/cli-tools": patch
"@hot-updater/aws": patch
"@hot-updater/supabase": patch
"@hot-updater/firebase": patch
"@hot-updater/test-utils": patch
---

The Insights release-ref backfill fits a store's write capacity. `hot-updater init` caps an AWS table at 100 write units a second, and one transaction of 13 event rewrites costs about 260 of them, so DynamoDB throttled the backfill until a transaction ran out of attempts and init stopped before deploying the server. The backfill now halves its transactions whenever the store stays busy through a transaction's attempts, as it already did for a transaction too large to write. One batch size holds for the whole run, so a refused batch is no longer read again at full size. AWS, Supabase, and Firebase init now run the backfill after deploying the new server, as Cloudflare, Vercel, and Azure init already did, so a backfill that stops leaves a working deployment, and the next init resumes it. A transaction that runs out of attempts on a busy store now says so, rather than reporting a conflict.
