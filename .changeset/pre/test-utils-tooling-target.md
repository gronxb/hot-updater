---
"@hot-updater/test-utils": patch
---

`setupReadBudgetTestSuite` creates the tables of core and of the `plugins` it measures, through its `server`'s `toolingTargetOf`, the one from `@hot-updater/server/database`. `createPluginTestHarness` keeps the table names of a plugin with `namespace: false`.
