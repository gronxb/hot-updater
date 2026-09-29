---
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
---

Add the read-budget suite. `@hot-updater/server/db` exports `createMeasuredDatabase(adapter, plugins, options?)`: core and the plugins' APIs assembled as `createHotUpdater` assembles them, on an engine in verify mode over a storage adapter without the schema fence, with `measureReads`.

`@hot-updater/test-utils` adds `setupReadBudgetTestSuite`, which seeds core and Insights on a backend with native pages capped at two rows and checks every API in the read-budget list at the adapter and at the engine, and `postgresRowsExamined` and `mysqlRowsExamined`, which explain each read a SQL core executor runs to count the rows the database examined.
