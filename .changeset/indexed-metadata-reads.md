---
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
"@hot-updater/server": patch
"@hot-updater/standalone": patch
"@hot-updater/plugin-core": patch
"@hot-updater/console": patch
"hot-updater": patch
---

Remove metadata full-scan fallbacks from Firebase, DynamoDB, Standalone and ORM
reads. Keep pagination and null ordering in the backend, use indexed MongoDB
predicates, load only affected rows for metadata commits, and query reverse patch
relations directly for Console child counts. Missing AWS projections and
unsupported queries fail explicitly instead of scanning history.

Existing AWS installations require the explicit metadata-index migration;
Firebase installations require the updated composite indexes. Standalone
servers must be redeployed for indexed patch-child queries.

Remove the unused fingerprint-only Release index from generated schemas and
append idempotent D1/Supabase cleanup migrations. Keep scope, patch relation and
Insights indexes used by current queries.
