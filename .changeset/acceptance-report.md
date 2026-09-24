---
"@hot-updater/server": minor
"@hot-updater/aws": patch
"@hot-updater/test-utils": minor
---

Measure every storage implementation against the redesign's acceptance checks, and bring each within them.

- **Server:** `createEngineDatabase` takes `onCachedRoutesChange`, called after a committed write that changes what the cacheable client routes answer (a Release Catalog row; a check op changes nothing). `dynamoDB` passes its CloudFront invalidation there instead of matching table names itself.
- **Transactions:** a transaction's write sends its deletes first, children before parents, so a unique value it frees can be reused in the same write; the parent-first insert order, which only foreign keys needed, is gone.
- **Adapters:** `mongoAdapter`'s `transactions` and `drizzleAdapter`'s `transaction` options, which were already ignored, are gone: every write runs in a transaction.
- **Schema tooling:** `migrateSchema` and `writeSchemaSettings` live with the db tooling; `@hot-updater/server/database` still exports them, and `HotUpdaterSchemaMigrationRequiredError` lives with the schema fence that throws it.
