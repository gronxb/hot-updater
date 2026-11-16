import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import {
  coreSettings,
  coreTarget,
  createEngineDatabase,
  createKvAdapter,
  createSqlAdapter,
  type DatabaseAdapter,
  type KeyValueStore,
  type PhysicalTable,
  SETTINGS_TABLE,
  type SqlExecutor,
  writeSchemaSettings,
} from "@hot-updater/plugin-core";
import {
  createMemoryKeyValueStore,
  setupDatabaseTestSuite,
  setupReadBudgetTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { pgliteExecutor, sqliteExecutor } from "@hot-updater/test-utils/node";
import { afterAll, expect } from "vitest";

import { createHotUpdater } from "../index";

/**
 * A 1.2 database without `release_catalog_partitions`, as a prerelease's
 * database is until its by-hand step, with partitioning off: every catalog,
 * core admin, bundle and read-budget case runs exactly as before, and no
 * read or write names the table. The SQL tables are dropped after the
 * migration, so any statement on them fails as it would there, and the
 * key-value store refuses its items as an IAM policy without the table does.
 */
const PARTITIONS = "release_catalog_partitions";

const touched: string[] = [];
afterAll(() => {
  expect(touched).toEqual([]);
});

/** Records, and refuses, any call that names the partition table. */
const refusingPartitions = (adapter: DatabaseAdapter): DatabaseAdapter => {
  const names = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(names);
    if (typeof value !== "object" || value === null) return false;
    const { name, table } = value as { name?: unknown; table?: unknown };
    return name === PARTITIONS || names(table);
  };
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (args.some(names)) {
          touched.push(String(property));
          throw new Error(`${String(property)} touched ${PARTITIONS}`);
        }
        return value.apply(target, args);
      };
    },
  });
};

/** A store whose policy has no `release_catalog_partitions` items, as DynamoDB's role before init puts the 1.2 policy. */
const refusingPartitionItems = (store: KeyValueStore): KeyValueStore => {
  const refuse = (pk: string) => {
    if (pk === PARTITIONS || pk.startsWith(`${PARTITIONS}#`)) {
      touched.push(pk);
      throw Object.assign(new Error("AccessDeniedException"), {
        name: "AccessDeniedException",
      });
    }
  };
  return {
    ...store,
    get: (keys) => {
      for (const { pk } of keys) refuse(pk);
      return store.get(keys);
    },
    query: (range) => {
      refuse(range.pk);
      return store.query(range);
    },
    write: (ops) => {
      for (const { key } of ops) refuse(key.pk);
      return store.write(ops);
    },
  };
};

const withoutPartitions = (tables: readonly PhysicalTable[]) =>
  tables.filter(({ name }) => name !== PARTITIONS);

const dataTables = withoutPartitions(coreTarget.schema.tables).map(
  ({ name }) => name,
);

const sqlBackends = {
  sqlite: () => {
    const db = new DatabaseSync(":memory:");
    return {
      executor: sqliteExecutor(db) as SqlExecutor,
      exec: async (sql: string) => db.exec(sql),
      close: async () => db.close(),
    };
  },
  pglite: () => {
    const db = new PGlite();
    return {
      executor: pgliteExecutor(db) as SqlExecutor,
      exec: (sql: string) => db.exec(sql).then(() => undefined),
      close: () => db.close(),
    };
  },
};

for (const [name, open] of Object.entries(sqlBackends)) {
  let backend: ReturnType<typeof open> | undefined;
  setupDatabaseTestSuite({
    name: `core without release_catalog_partitions (${name})`,
    createHttpClient: (options) =>
      startHttpTestServer(
        createHotUpdater({ ...options, clientAccess: "public" }).handlers,
      ),
    migrate: async () => {
      backend = open();
      const adapter = createSqlAdapter({ executor: backend.executor });
      await adapter.migrations!.apply([
        ...coreTarget.schema.tables,
        SETTINGS_TABLE,
      ]);
      await writeSchemaSettings(adapter, name, coreSettings);
      await backend.exec(`DROP TABLE "${PARTITIONS}"`);
    },
    createDatabase: () =>
      createEngineDatabase({
        name,
        adapter: refusingPartitions(
          createSqlAdapter({ executor: backend!.executor }),
        ),
      }),
    reset: async () => {
      for (const table of dataTables) {
        await backend!.exec(`DELETE FROM "${table}"`);
      }
    },
    dispose: async () => {
      await backend!.close();
      backend = undefined;
    },
  });

  setupReadBudgetTestSuite({
    name: `read budgets without release_catalog_partitions (${name})`,
    partitions: false,
    createAdapter: async ({ tables }) => {
      const opened = open();
      const adapter = createSqlAdapter({ executor: opened.executor });
      await adapter.migrations!.apply(withoutPartitions(tables));
      return { adapter: refusingPartitions(adapter), cleanup: opened.close };
    },
  });
}

let store: ReturnType<typeof createMemoryKeyValueStore> | undefined;
setupDatabaseTestSuite({
  name: "core without release_catalog_partitions (key-value store)",
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({ ...options, clientAccess: "public" }).handlers,
    ),
  migrate: async () => {
    store = createMemoryKeyValueStore();
    await writeSchemaSettings(
      createKvAdapter({ store }),
      "key-value",
      coreSettings,
    );
  },
  createDatabase: () =>
    createEngineDatabase({
      name: "key-value",
      adapter: refusingPartitions(
        createKvAdapter({ store: refusingPartitionItems(store!) }),
      ),
    }),
  // The suite's cleanup deletes what each test created.
  reset: () => undefined,
  dispose: () => {
    store = undefined;
  },
});

setupReadBudgetTestSuite({
  name: "read budgets without release_catalog_partitions (key-value store)",
  partitions: false,
  createAdapter: async ({ nativePageSize }) => ({
    adapter: refusingPartitions(
      createKvAdapter({
        store: refusingPartitionItems(
          createMemoryKeyValueStore({ nativePageSize }),
        ),
      }),
    ),
    indexCopies: true,
  }),
});
