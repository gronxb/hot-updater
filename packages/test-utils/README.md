# @hot-updater/test-utils

Shared Vitest conformance tests for custom Hot Updater database providers and
HTTP servers. Official providers and example servers run these same scenarios.

```bash
pnpm add -D @hot-updater/test-utils @hot-updater/server vitest
```

Connect your database lifecycle and the real server:

```ts
import { createHotUpdater } from "@hot-updater/server";
import {
  setupDatabasePluginTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { myDatabase } from "./myDatabase";
import { db, migrateDatabase, resetDatabase } from "./testDatabase";

setupDatabasePluginTestSuite({
  name: "my database",
  createPlugin: () => myDatabase({ db }),
  migrate: () => migrateDatabase(db),
  reset: () => resetDatabase(db),
  dispose: async (plugin) => { await plugin.dispose?.(); },
  createHttpClient: (options) => startHttpTestServer(
    createHotUpdater({ ...options, clientAccess: { type: "public" } }).handlers,
  ),
});
```

Run the spec with `pnpm exec vitest run`. Use an isolated test database; reset
all data before each scenario while retaining its schema and version settings.

Passing the complete suite verifies the DatabasePlugin and Release Catalog
HTTP contracts for the installed Hot Updater version: model semantics,
transactions, pagination, relations, Insights, catalog projections and caching,
and artifact responses. The HTTP scenarios use real `fetch` requests on Node,
including independent Release/Catalog expectations and competing conditional
writes. Run the entire suite against your provider's actual test backend without
skipping scenarios or replacing model methods with mocks.

The repository also runs the public suite against deliberately broken providers
to check that contract violations fail. This is a versioned compatibility gate;
passing is evidence for the exercised contracts, not a proof of every possible
execution or deployment condition.
Add provider-specific migration, concurrency, storage, and deployment tests
where those need separate verification.

Use `setupReleaseCatalogTestSuite` with `createHttpTestClient` to test an existing
server by URL. Use `createHandlerHttpTestClient` for a Workers Vitest pool.
Server processes can import `createReleaseCatalogTestStorage` from
`@hot-updater/test-utils/node` to install the suite's storage fixtures.

See the [custom database guide](https://hot-updater.dev/docs/database-plugins/custom-database)
for the full setup and contract boundaries.
