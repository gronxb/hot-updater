---
"@hot-updater/plugin-core": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
"@hot-updater/standalone": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
"@hot-updater/mock": patch
"@hot-updater/server": patch
---

Let the database adapter factory own validation, model query planning and lazy
initialization for both transactional and native providers. Native adapters no
longer need unused CRUD mutation implementations. Remove DynamoDB's duplicate
metadata writers, Firebase's in-memory query engine and Standalone's CRUD query
emulation while preserving native atomic writes and bounded reads.

Serialize DynamoDB relationship mutations and Release creation against parent
deletion with version guards captured before relationship queries. Cache absent
Firebase transaction reads without resurrecting staged deletions.
