import { createHotUpdater } from "@hot-updater/server";
import { createKvAdapter } from "@hot-updater/server/database";
import { HotUpdaterSchemaMigrationRequiredError } from "@hot-updater/server/db";
import {
  setupDatabaseAdapterConformanceSuite,
  setupDatabasePluginTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createFirestoreTestDatabase } from "../test-utils/createFirestoreTestDatabase";
import { firebaseDatabase, migrateFirebaseDatabase } from "./firebaseDatabase";
import { createFirestoreStore } from "./firestoreStore";

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
  writers: 16,
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
    const plugin = firebaseDatabase(config);
    await expect(plugin.models.channels.list({})).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    await migrateFirebaseDatabase(config);
    await migrateFirebaseDatabase(config);
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [],
    });
  });

  setupDatabasePluginTestSuite({
    name: "firebaseDatabase (Firestore emulator)",
    createHttpClient: (options) =>
      startHttpTestServer(
        createHotUpdater({ ...options, clientAccess: { type: "public" } })
          .handlers,
      ),
    createPlugin: () => firebaseDatabase(config),
    migrate: () => migrateFirebaseDatabase(config),
    reset: clearData,
    dispose: () => undefined,
  });
});
