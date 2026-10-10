import {
  createKvAdapter,
  type PhysicalTable,
  HotUpdaterSchemaMigrationRequiredError,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { createInsightsModel, insights } from "@hot-updater/server/plugins";
import {
  setupDatabaseAdapterConformanceSuite,
  setupDatabaseTestSuite,
  startHttpTestServer,
  insightsTestSuite,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createFirestoreTestDatabase } from "../test-utils/createFirestoreTestDatabase";
import { firebaseDatabase, migrateFirebaseDatabase } from "./firebaseDatabase";
import { createFirestoreStore, FIRESTORE_TTL_FIELD } from "./firestoreStore";

const PROJECT_ID = "firebase-database-test";
const config = {
  projectId: PROJECT_ID,
  storageBucket: `${PROJECT_ID}.appspot.com`,
};
const { firestore, clearData, clearCollection } =
  createFirestoreTestDatabase(PROJECT_ID);

let collections = 0;
setupDatabaseAdapterConformanceSuite({
  name: "key-value (Firestore emulator)",
  // A conformance insert is 3 items and a transaction takes 500 writes: 166 fit, 167 do not.
  maxOps: 166,
  // Firestore's TTL policy deletes expired items, by their `expireAt`.
  retention: "ttl",
  createAdapter: async ({ nativePageSize }) => {
    const collection = `conformance_${process.pid}_${(collections += 1)}`;
    return {
      adapter: createKvAdapter({
        store: createFirestoreStore({ firestore, collection, nativePageSize }),
      }),
      cleanup: () => clearCollection(collection),
    };
  },
});

describe("firebaseDatabase", () => {
  it("serves only after the migration writes the schema settings", async () => {
    await clearCollection("hot_updater_v1");
    const core = createHotUpdater({
      database: firebaseDatabase(config),
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    }).core;
    await expect(core.listChannels()).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    await migrateFirebaseDatabase(config);
    await migrateFirebaseDatabase(config);
    await expect(core.listChannels()).resolves.toEqual([]);
  });

  setupDatabaseTestSuite({
    name: "firebaseDatabase (Firestore emulator)",
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
    createDatabase: () => firebaseDatabase(config),
    migrate: () => migrateFirebaseDatabase(config, [insights()]),
    reset: clearData,
    dispose: () => undefined,
  });
});

describe("Firestore TTL", () => {
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

  it("stamps expireAt on every document of an expiring row, and on a counter it creates or adds to", async () => {
    const collection = `ttl_${process.pid}`;
    const adapter = createKvAdapter({
      store: createFirestoreStore({ firestore, collection }),
    });
    const expiries = async () =>
      (await firestore.collection(collection).get()).docs.map((document) =>
        document.get(FIRESTORE_TTL_FIELD)?.toMillis(),
      );
    try {
      await adapter.write([
        {
          type: "insert",
          table: expiring,
          row: { id: "a", grp: "g", at: 1_000, hits: 0, _v: 0 },
        },
      ]);
      // The row and its index copy.
      expect(await expiries()).toEqual([86_401_000, 86_401_000]);

      await clearCollection(collection);
      const counters = { ...expiring, name: "counters", indexes: [] };
      const add = () =>
        adapter.write([
          {
            type: "increment",
            table: counters,
            key: ["c"],
            by: { hits: 1 },
            init: { id: "c", grp: "g", at: 2_000, hits: 0, _v: 0 },
          },
        ]);
      await add();
      await add();
      expect(await expiries()).toEqual([86_402_000]);
      const [row] = await adapter.get(counters, [["c"]]);
      expect(row).toMatchObject({ hits: 2, _v: 2 });
    } finally {
      await clearCollection(collection);
    }
  });
});
