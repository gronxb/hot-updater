import {
  createKvAdapter,
  type PhysicalTable,
  HotUpdaterSchemaMigrationRequiredError,
  SETTINGS_TABLE,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { createInsightsModel, insights } from "@hot-updater/server/plugins";
import {
  setupAggregateBatchingTestSuite,
  setupDatabaseAdapterConformanceSuite,
  setupDatabaseTestSuite,
  setupReadBudgetTestSuite,
  startHttpTestServer,
  insightsTestSuite,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type CosmosEmulator,
  startCosmosEmulator,
} from "../test-utils/azureEmulators";
import { AZURE_COSMOS_V1_CONTAINER } from "./azureInfrastructureNames";
import { cosmosDatabase, migrateCosmosDatabase } from "./cosmosDatabase";
import {
  COSMOS_LIMITS,
  COSMOS_PARTITION,
  COSMOS_PARTITION_KEY_PATH,
  createCosmosStore,
} from "./cosmosStore";

// One emulator for every suite: it is heavy, so files do not each start one.
let emulator: CosmosEmulator;
beforeAll(async () => {
  emulator = await startCosmosEmulator();
}, 240_000);
afterAll(async () => {
  await emulator?.stop();
});

/** A store in a database of its own, which its migration creates. */
const createStore = async (nativePageSize?: number) => {
  const databaseId = emulator.databaseId();
  const store = createCosmosStore({
    client: emulator.client,
    databaseId,
    containerId: AZURE_COSMOS_V1_CONTAINER,
    nativePageSize,
  });
  await store.migrations!.apply();
  return {
    store,
    container: emulator.client
      .database(databaseId)
      .container(AZURE_COSMOS_V1_CONTAINER),
    cleanup: () => emulator.dropDatabase(databaseId),
  };
};

setupDatabaseAdapterConformanceSuite({
  name: "key-value (Cosmos DB emulator)",
  // 34 conformance inserts are 102 items, over the 100 one batch takes.
  maxOps: 33,
  // Cosmos DB deletes expired items itself, by their `ttl`.
  retention: "ttl",
  createAdapter: async ({ nativePageSize }) => {
    const { store, cleanup } = await createStore(nativePageSize);
    return { adapter: createKvAdapter({ store }), cleanup };
  },
});

/**
 * `cosmosDatabase()`'s storage without its schema fence: the key-value
 * helper over the Cosmos DB store in the emulator, its pages as small as the
 * suite's.
 */
setupReadBudgetTestSuite({
  name: "key-value (Cosmos DB emulator)",
  createAdapter: async ({ nativePageSize }) => {
    const { store, cleanup } = await createStore(nativePageSize);
    return { adapter: createKvAdapter({ store }), indexCopies: true, cleanup };
  },
});

/** `cosmosDatabase()`'s batching in the Cosmos DB emulator, a database per case. */
setupAggregateBatchingTestSuite({
  name: "key-value (Cosmos DB emulator)",
  createAdapter: async () => {
    const { store, cleanup } = await createStore();
    return { adapter: createKvAdapter({ store }), cleanup };
  },
  // Past the 100 items one batch takes: the compaction splits it.
  oversizedRows: COSMOS_LIMITS.items + 50,
});

describe("cosmosDatabase", () => {
  const config = () => ({
    connectionString: emulator.connectionString,
    connectionPolicy: { enableEndpointDiscovery: false },
    databaseId: "hot-updater-database-spec",
  });
  /** Every item but the schema settings, which the database checks first. */
  const clearData = async () => {
    const container = emulator.client
      .database(config().databaseId)
      .container(AZURE_COSMOS_V1_CONTAINER);
    const { resources } = await container.items
      .query<{ id: string }>(
        {
          query: "SELECT c.id FROM c WHERE c.pk != @settings",
          parameters: [{ name: "@settings", value: SETTINGS_TABLE.name }],
        },
        { partitionKey: COSMOS_PARTITION },
      )
      .fetchAll();
    const results = await container.items.executeBulkOperations(
      resources.map(({ id }) => ({
        operationType: "Delete" as const,
        id,
        partitionKey: COSMOS_PARTITION,
      })),
    );
    const failed = results.filter(
      ({ response }) => response === undefined || response.statusCode >= 400,
    );
    if (failed.length > 0) {
      throw new Error(`clearData left ${failed.length} item(s)`, {
        cause: failed[0]!.error,
      });
    }
  };

  it("serves only after the migration creates the container and writes the schema settings", async () => {
    const core = createHotUpdater({
      database: cosmosDatabase(config()),
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    }).core;
    await expect(core.listChannels()).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    await migrateCosmosDatabase(config());
    await migrateCosmosDatabase(config());
    await expect(core.listChannels()).resolves.toEqual([]);
  });

  it("refuses a container partitioned by another path", async () => {
    const databaseId = emulator.databaseId();
    try {
      const { database } = await emulator.client.databases.createIfNotExists({
        id: databaseId,
      });
      await database.containers.createIfNotExists({
        id: AZURE_COSMOS_V1_CONTAINER,
        partitionKey: { paths: ["/id"] },
      });
      await expect(
        migrateCosmosDatabase({ ...config(), databaseId }),
      ).rejects.toThrow(COSMOS_PARTITION_KEY_PATH);
    } finally {
      await emulator.dropDatabase(databaseId);
    }
  });

  it.each([
    ["another storage engine", "9", false],
    ["no engine marker beside other items", null, true],
    ["no engine marker beside another partition's items", null, "other"],
  ] as const)(
    "refuses to migrate a container with %s",
    async (_, engine, otherItem) => {
      const databaseId = emulator.databaseId();
      try {
        const named = { ...config(), databaseId };
        await migrateCosmosDatabase(named);
        const container = emulator.client
          .database(databaseId)
          .container(AZURE_COSMOS_V1_CONTAINER);
        const { resources } = await container.items
          .query<{ id: string; row: { key: string } }>(
            "SELECT c.id, c.row FROM c",
            { partitionKey: COSMOS_PARTITION },
          )
          .fetchAll();
        const marker = resources.find(
          ({ row }) => row.key === "schema.engine",
        )!;
        if (engine === null) {
          await container.item(marker.id, COSMOS_PARTITION).delete();
        } else {
          await container
            .item(marker.id, COSMOS_PARTITION)
            .patch([{ op: "set", path: "/row/value", value: engine }]);
        }
        if (otherItem) {
          await container.items.create(
            otherItem === "other"
              ? { id: "another-app", partition: "another-app" }
              : {
                  id: "existing-item",
                  partition: COSMOS_PARTITION,
                  pk: "bundles",
                  sk: "a",
                  row: {},
                },
          );
        }
        await expect(migrateCosmosDatabase(named)).rejects.toThrow(
          engine === null ? "no schema.engine setting" : 'storage engine "9"',
        );
      } finally {
        await emulator.dropDatabase(databaseId);
      }
    },
  );

  it("adopts an existing container with its default indexing and no default TTL", async () => {
    const databaseId = emulator.databaseId();
    try {
      const { database } = await emulator.client.databases.createIfNotExists({
        id: databaseId,
      });
      await database.containers.createIfNotExists({
        id: AZURE_COSMOS_V1_CONTAINER,
        partitionKey: { paths: [COSMOS_PARTITION_KEY_PATH] },
      });
      await migrateCosmosDatabase({ ...config(), databaseId });
      const core = createHotUpdater({
        database: cosmosDatabase({ ...config(), databaseId }),
        storage: createReleaseCatalogTestStorage(),
        clientAccess: "public",
      }).core;
      await expect(core.listChannels()).resolves.toEqual([]);
    } finally {
      await emulator.dropDatabase(databaseId);
    }
  });

  setupDatabaseTestSuite({
    name: "cosmosDatabase (Cosmos DB emulator)",
    createHttpClient: (options) =>
      startHttpTestServer(
        createHotUpdater({
          ...options,
          plugins: [insights()],
          clientAccess: "public",
        }).handlers,
      ),
    plugins: [
      insightsTestSuite({
        createModel: (database) =>
          createInsightsModel(
            createHotUpdater({
              database,
              storage: createReleaseCatalogTestStorage(),
              plugins: [insights()],
              clientAccess: "public",
            }).api.insights,
          ),
      }),
    ],
    createDatabase: () => cosmosDatabase(config()),
    migrate: () => migrateCosmosDatabase(config(), [insights()]),
    reset: clearData,
    dispose: () => undefined,
  });
});

describe("Cosmos DB TTL", () => {
  /** Rows expire a day after `at`, with one index copy each. */
  const expiring: PhysicalTable = {
    name: "expiring",
    columns: [
      { name: "id", type: "string", nullable: false },
      { name: "grp", type: "string", nullable: false },
      { name: "at", type: "integer", nullable: false },
      { name: "hits", type: "integer", nullable: false },
      { name: "_v", type: "integer", nullable: false },
    ],
    key: ["id"],
    indexes: [{ name: "byGroup", eq: ["grp"], sort: ["at"] }],
    retention: { column: "at", ms: 86_400_000 },
  };

  it("stamps the expiry on every item of an expiring row, and on a counter it creates or adds to", async () => {
    const { store, container, cleanup } = await createStore();
    const adapter = createKvAdapter({ store });
    const items = async () => {
      const { resources } = await container.items
        .query<{ expireAt: number | null; ttl: number }>(
          "SELECT c.expireAt, c.ttl FROM c",
          { partitionKey: COSMOS_PARTITION },
        )
        .fetchAll();
      return resources;
    };
    try {
      const now = Date.now();
      await adapter.write([
        {
          type: "insert",
          table: expiring,
          row: { id: "a", grp: "g", at: now, hits: 0, _v: 0 },
        },
      ]);
      // The row and its index copy, each with the TTL left until the expiry.
      const written = await items();
      expect(written.map(({ expireAt }) => expireAt)).toEqual([
        now + 86_400_000,
        now + 86_400_000,
      ]);
      expect(written.map(({ ttl }) => ttl)).toEqual([86_400, 86_400]);

      const counters = { ...expiring, name: "counters", indexes: [] };
      const add = () =>
        adapter.write([
          {
            type: "increment",
            table: counters,
            key: ["c"],
            by: { hits: 1 },
            init: { id: "c", grp: "g", at: now + 1_000, hits: 0, _v: 0 },
          },
        ]);
      await add();
      await add();
      const [row] = await adapter.get(counters, [["c"]]);
      expect(row).toMatchObject({ hits: 2, _v: 2 });
      expect(
        (await items()).filter(({ expireAt }) => expireAt === now + 86_401_000),
      ).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
