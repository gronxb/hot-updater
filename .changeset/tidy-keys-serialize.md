---
"@hot-updater/server": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
"hot-updater": patch
---

Serialize Kysely database commits and retry native serialization conflicts so concurrent Release revision and Catalog generation expectations cannot both succeed with the same version.

Replace Firebase row fields atomically instead of recursively merging JSON metadata, while preserving unrelated document extension fields.

The single Supabase 1.0.0 initialization migration makes generic deletion of a missing Channel an atomic no-op. For older RC projects, replace only the commit RPC using the supplied definition and permissions; preserve table layouts, schema version, existing data and migration history.
