---
"@hot-updater/console": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/cli-tools": minor
---

Move the console onto core's API: key cursors, indexed filter sets, counters, and a banner when Insights is off.

- **Bundles:** the list pages by key, with Previous, Next, and Newest in place of page numbers. Each page reads only its own releases.
- **Filters:** the filters are the sets the release indexes serve: a channel with its platform (and status), an artifact, or a target, which is one catalog scope. The platform filter works with a channel, and the target app version filter is replaced by "Show bundles for this target" in a bundle's diagnostics.
- **Counters:** patch counts and a bundle's children come from its reference counter and the patches index, not from paging every bundle. Bundle totals come from one counter row.
- **Core:** bundles, releases, catalogs, and channels go through core's API: in process on the database's storage engine, or over a self-hosted server's admin API protocol 2. Creating a channel takes its name. A database that is not on the storage engine is refused with a message to upgrade its provider.
- **Insights off:** when the server runs without `insights()`, the Insights pages and bundle panels show that Insights is off instead of an error. A self-hosted server is asked through its admin API, which answers 204 with `x-hot-updater-insights: disabled`. The console reads a self-hosted server's events and installations there. Usage and bundle activity need the database config.
- **Plugins in the console:** `defineConsoleConfig({ plugins })` and a project's `hotUpdater.plugins.ts`, which `hot-updater console` loads, give the console the plugins the server runs. It assembles them over the database with `createDatabasePluginApis` from `@hot-updater/server/db`, on the server's tables. Without `plugins`, the database plugin serves Insights and API keys until 1.0.
- **API keys:** the console manages keys through the `apiKeys()` plugin's API, or the database plugin's without `plugins`. It does not manage a self-hosted server's keys.
- **`standaloneRepository`:** it has `fetchAdmin(path)`, a GET on the server's admin handler with the repository's headers.
- **`@hot-updater/cli-tools`:** it adds `loadHotUpdaterPlugins`.
