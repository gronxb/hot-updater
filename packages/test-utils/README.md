# @hot-updater/test-utils

Test suites and helpers for Hot Updater storage adapters, database adapters,
providers, server plugins, client plugins and servers. The official adapters,
providers, plugins and example servers run these same suites.

```bash
pnpm add -D @hot-updater/test-utils @hot-updater/server vitest
```

It uses the other Hot Updater packages only through their public API, and
takes them as peer dependencies. `@hot-updater/server` and
`@hot-updater/plugin-insights` are optional: the database suites load the
server when they run, and the Insights suites use the plugin's types. The SQL
test executors of `@hot-updater/test-utils/node` take `pg`, `mysql2` or
`@electric-sql/pglite`, whichever you test on.

## Database adapters and providers

Register three suites against a disposable test database:

- `setupDatabaseAdapterConformanceSuite` runs the database adapter contract case
  by case: value round-trips, ordering, guards, all-or-nothing writes, unique
  and multi-valued indexes, paging under capped native pages, and concurrent
  writers.
- `setupReadBudgetTestSuite` checks what each read of core and the built-in
  plugins costs at the adapter, on `createMeasuredDatabase`: `createHotUpdater`
  over `meterReads({ name, adapter: verifyAdapter(adapter) })` from
  `@hot-updater/plugin-core`. `postgresRowsExamined` and `mysqlRowsExamined`
  also count the rows a SQL database examined.
- `setupDatabaseTestSuite` runs core, Bundles and the Release Catalog contract
  through the admin and client HTTP APIs of `createHotUpdater`, then the suites
  of the server plugins listed in `plugins`, such as the Insights plugin's
  `insightsTestSuite()`.

Connect your database's lifecycle and the real server:

```ts
import { createHotUpdater } from "@hot-updater/server";
import {
  createInsightsModel,
  insights,
} from "@hot-updater/server/plugins/insights";

import {
  insightsTestSuite,
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
  // The server above runs insights(), so its suite runs too.
  plugins: [
    insightsTestSuite({
      // The plugin's API on the database, as a server running it assembles it.
      createModel: (database) =>
        createInsightsModel(
          createHotUpdater({
            database,
            plugins: [insights()],
            clientAccess: "public",
          }).api.insights,
        ),
    }),
  ],
});
```

`migrate` creates the tables and schema settings once. `reset` empties every
data table before each test and keeps the settings rows. Run the suites
against your actual backend without skipping cases or mocking the database.
The Release Catalog scenarios feed each catalog they receive to the production
client selector and keep a simulated device's state across updates, rollbacks
and the built-in fallback. Native download, activation and restart remain
device end-to-end responsibilities.

## Storage adapters

`setupStorageAdapterTestSuite` runs the storage adapter contract that deploy,
patch, the Console, the server and `storage prune` rely on: the canonical URI
of each key below the base path, streamed bodies, failed uploads that leave no
object, exact deletes, URIs of another bucket or protocol, download URLs, and
listing. A storage adapter's specs don't need `@hot-updater/server`.

```ts
import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";

import { myStorage } from "./myStorage";

setupStorageAdapterTestSuite({
  name: "myStorage",
  createStorage: async () => ({
    storage: myStorage({ bucket: "bundles", basePath: "ota" }),
    basePath: "ota",
  }),
  operations: ["put", "get", "getDownloadUrl", "exists", "delete"],
});
```

`createStorage` returns the adapter over an empty bucket or base path for each
case, and the `cleanup` it may return runs after the case. `operations` lists
what the adapter implements: the suite fails when one of them is missing and
skips the cases of the others.

With `fetchDownloadUrls: true`, the suite downloads every `http(s)` URL
`getDownloadUrl` returns and requires the object's bytes, for a spec against a
real bucket or emulator whose URLs the test can reach.

## Plugins and servers

- `createPluginTestHarness` runs one server plugin on `createEngine` from
  `@hot-updater/plugin-core`, the engine `createHotUpdater` runs plugins on, on
  a memory adapter by default, and measures what each API call reads.
- `setupReleaseCatalogTestSuite` with `createHttpTestClient` tests a running
  server by URL. Use `createHandlerHttpTestClient` inside a Workers Vitest pool.
- Server processes can import `createReleaseCatalogTestStorage` from
  `@hot-updater/test-utils/node` to install the suites' storage fixtures.

## Client plugins

`@hot-updater/test-utils/react-native` runs client plugins the way the app
does. `setupClientPlugin(plugin, options)` and
`setupClientPlugins(plugins, options)` set plugins up as `HotUpdater.init`
does, on the plugin host from `@hot-updater/protocol`, the one the SDK runs,
against an in-memory device and a server the test answers. The entry loads
neither React Native nor Vitest, so plugin specs run in plain Node under
Vitest or Jest when the plugin imports `defineClientPlugin` from
`@hot-updater/protocol`; the SDK's root entry loads React Native.

```ts
import { setupClientPlugin } from "@hot-updater/test-utils/react-native";

const runtime = setupClientPlugin(myPlugin(), {
  requestHeaders: { "x-api-key": "client-key" },
});

runtime.hooks.onAppReady(launch);
await runtime.settled();

expect(runtime.requests[0]?.json()).toEqual(expectedEvent);
expect(runtime.errors).toEqual([]);
```

`hooks` calls each hook as the SDK does, without waiting for it, and
`settled()` waits for what the hooks started. `requests` records what plugins
sent with `context.fetch`, and the `respond` option answers each request,
`204 No Content` by default. `errors` holds what the SDK reports to `onError`.
`storage` is the device's plugin storage: pass it to the next setup to start
the plugins again on the same device, or seed one with `createTestStorage()`.

See the
[storage adapter guide](https://hot-updater.dev/docs/storage-adapters/custom-storage#test-the-adapter),
the
[database adapter guide](https://hot-updater.dev/docs/database-adapters/custom-database),
and the
[client plugin guide](https://hot-updater.dev/docs/react-native-api/client-plugins#test-the-plugin)
for the contracts and complete specs.
