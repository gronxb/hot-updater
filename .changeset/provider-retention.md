---
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
"hot-updater": patch
---

Each provider deletes rows past their table's retention with no scheduler. DynamoDB deletes items by Time to Live on `_ttl`: `migrateDynamoDB`, `hot-updater db migrate`, and the managed AWS setup turn it on, and `hot-updater infra scaffold` writes `dynamodb/enable-ttl.json`. Firestore deletes documents by a TTL policy on `expireAt`, declared in `firestore.indexes.json`. Cloudflare D1 and Supabase delete them during writes, in bounded batches, within D1's query limit for one Worker invocation and through Supabase's apply RPC. The PostgreSQL, D1, and Supabase schemas add the Insights daily and lifetime tables and the indexes pruning walks. A deployment from a 1.0.0 release candidate recreates its database and updates the server, app, and console together.
