# @hot-updater/test-utils

Vitest suites for Hot Updater database adapters, providers and servers. The
official providers and example servers run these same suites.

```bash
pnpm add -D @hot-updater/test-utils @hot-updater/server vitest
```

## Database adapters and providers

Register three suites against a disposable test database:

- `setupDatabaseAdapterConformanceSuite` runs the storage adapter contract case
  by case: value round-trips, ordering, guards, all-or-nothing writes, unique
  and multi-valued indexes, paging under capped native pages, and concurrent
  writers.
- `setupReadBudgetTestSuite` checks what each read of core and the built-in
  plugins costs at the adapter, using `createMeasuredDatabase` from
  `@hot-updater/server/db`. `postgresRowsExamined` and `mysqlRowsExamined` also
  count the rows a SQL database examined.
- `setupDatabaseTestSuite` runs core, Bundles, the Release Catalog contract and
  Insights through the admin and client HTTP APIs of `createHotUpdater`.

Connect your database's lifecycle and the real server:

```ts
import { createHotUpdater } from "@hot-updater/server";
import { createDatabasePluginApis } from "@hot-updater/server/db";
import {
  createInsightsModel,
  insights,
} from "@hot-updater/server/plugins/insights";
import {
  setupDatabaseTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";

import { migrateMyDatabase, myDatabase } from "./myDatabase";
import { resetMyDatabase } from "./testDatabase";

const config = { connectionString: process.env.TEST_DATABASE_URL };

setupDatabaseTestSuite({
  name: "my database",
  migrate: () => migrateMyDatabase(config),
  createDatabase: () => myDatabase(config),
  reset: () => resetMyDatabase(config),
  dispose: async (database) => {
    await database.dispose?.();
  },
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({
        ...options,
        plugins: [insights()],
        clientAccess: "public",
      }).handlers,
    ),
  createInsightsModel: (database) =>
    createInsightsModel(
      createDatabasePluginApis(database, [insights()]).insights,
    ),
});
```

`migrate` creates the tables and schema settings once. `reset` empties every
data table before each test and keeps the settings rows. Run the suites
against your actual backend without skipping cases or mocking the database.
The Release Catalog scenarios feed each catalog they receive to the production
client selector and keep a simulated device's state across updates, rollbacks
and the built-in fallback. Native download, activation and restart remain
device end-to-end responsibilities.

## Plugins and servers

- `createPluginTestHarness` runs one server plugin the way `createHotUpdater`
  does, on a memory adapter by default, and measures what each API call reads.
- `setupReleaseCatalogTestSuite` with `createHttpTestClient` tests a running
  server by URL. Use `createHandlerHttpTestClient` inside a Workers Vitest pool.
- Server processes can import `createReleaseCatalogTestStorage` from
  `@hot-updater/test-utils/node` to install the suites' storage fixtures.

See the
[custom database adapter guide](https://hot-updater.dev/docs/database-plugins/custom-database)
for the adapter contract and complete specs for each suite.
