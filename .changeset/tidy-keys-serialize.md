---
"@hot-updater/server": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
---

Serialize Kysely database commits and retry native serialization conflicts so concurrent Release revision and Catalog generation expectations cannot both succeed with the same version.

Replace Firebase row fields atomically instead of recursively merging JSON metadata, while preserving unrelated document extension fields.

Apply Supabase migration `20260922000000_idempotent_channel_commit.sql` to existing generation 1 projects. It makes generic deletion of a missing Channel an atomic no-op, preserving table layouts, schema version, existing data, and RPC permissions.
