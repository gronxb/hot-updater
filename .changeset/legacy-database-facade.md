---
"@hot-updater/server": minor
---

Add the legacy façade. `createLegacyDatabasePlugin({ name, adapter })`, exported from the unstable `@hot-updater/server/database` subpath, serves today's `DatabasePlugin` over the new database engine, core, and the built-in Insights and API keys plugins, until E2 retires that contract. Providers switch to it one by one in the D PRs.

- **Models:** every model reads through core's reads and the plugins' models. Commits that span core and API keys run in one transaction.
- **Legacy query shapes:** the engine has no offsets, no counts with id filters, and no filters outside an index. The façade emulates them by paging through the nearest index, and it is removed with them.
- **Hidden placeholders:** placeholder catalogs from raw release commits stay hidden.
- **Engine adapter:** the façade sets `engineAdapter`, so plugins passed to `createHotUpdater` run on the same storage.
