import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import {
  createMemoryKeyValueStore,
  setupKeyOrderTestSuite,
} from "@hot-updater/test-utils";
import { pgliteExecutor, sqliteExecutor } from "@hot-updater/test-utils/node";

import { createMemoryAdapter } from "../../database/memoryAdapter";
import { createKvAdapter } from "./kv/kvAdapter";
import { createSqlAdapter } from "./sql/sqlAdapter";

/**
 * `release_catalog_partitions`' byte order on the stores this package
 * implements: the memory adapter, the SQL core's own DDL on SQLite and
 * PGlite, and the key-value kit's sort keys, each under a table prefix.
 */
setupKeyOrderTestSuite({
  name: "memory",
  createAdapter: async () => ({
    adapter: createMemoryAdapter({ tablePrefix: "p_" }),
  }),
});

setupKeyOrderTestSuite({
  name: "sql (SQLite)",
  createAdapter: async ({ table }) => {
    const db = new DatabaseSync(":memory:");
    const adapter = createSqlAdapter({
      executor: sqliteExecutor(db),
      tablePrefix: "p_",
    });
    await adapter.migrations?.apply([table]);
    return { adapter, cleanup: async () => db.close() };
  },
});

setupKeyOrderTestSuite({
  name: "sql (PGlite)",
  createAdapter: async ({ table }) => {
    const db = new PGlite();
    const adapter = createSqlAdapter({
      executor: pgliteExecutor(db),
      tablePrefix: "p_",
    });
    await adapter.migrations?.apply([table]);
    return { adapter, cleanup: () => db.close() };
  },
});

setupKeyOrderTestSuite({
  name: "key-value (in-memory store)",
  // DynamoDB's sort key: 1,024 bytes for the scope key, the epoch, the lower
  // key and their separators.
  maxScopeKeyBytes: 1024 - 36 - 256 - 3,
  createAdapter: async () => ({
    adapter: createKvAdapter({
      store: createMemoryKeyValueStore(),
      tablePrefix: "p_",
    }),
  }),
});
