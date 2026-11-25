---
"@hot-updater/plugin-insights": patch
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/cli-tools": patch
"@hot-updater/aws": patch
"@hot-updater/supabase": patch
"@hot-updater/firebase": patch
"@hot-updater/test-utils": patch
---

The Insights release-ref backfill and the release-label fill now fit a store's write capacity.
- **Smaller transactions when the store is busy.** `hot-updater init` caps an AWS table at 100 write units a second, and one backfill transaction of 13 event rewrites costs about 260 of them. DynamoDB throttled the backfill until a transaction ran out of attempts, and init stopped before it deployed the server. Both bulk writers now halve their transactions whenever the store stays busy through a transaction's attempts, as they already did for a transaction too large to write.
- **One batch size per run.** The backfill keeps one batch size for the whole run, so it no longer reads a refused batch again at full size.
- **Backfill after deploy.** AWS, Supabase, and Firebase init now run the backfill after they deploy the new server, as Cloudflare, Vercel, and Azure init already did. A backfill that stops leaves a working deployment, and the next init resumes it.
- **Clearer error.** A transaction that runs out of attempts on a busy store now says so, instead of reporting a conflict.
