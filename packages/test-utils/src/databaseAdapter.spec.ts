import {
  createBlobDatabaseAdapter,
  createDatabaseClient,
} from "@hot-updater/plugin-core";
import { beforeEach } from "vitest";

import { setupDatabaseAdapterTestSuite } from "./setupDatabaseAdapterTestSuite";
import { setupDatabaseClientTestSuite } from "./setupDatabaseClientTestSuite";

const store = new Map<string, unknown>();
const invalidations: string[][] = [];

const createMemoryAdapter = () =>
  createBlobDatabaseAdapter({
    name: "memoryBlobDatabase",
    adapter: () => ({
      apiBasePath: "/api/check-update",
      listObjects: async (prefix) =>
        [...store.keys()].filter((key) => key.startsWith(prefix)),
      loadObject: async (key) => store.get(key) ?? null,
      uploadObject: async (key, data) => {
        store.set(key, data);
      },
      compareAndSwapObject: async (key, expected, data) => {
        if (
          JSON.stringify(store.get(key) ?? null) !== JSON.stringify(expected)
        ) {
          return false;
        }
        store.set(key, data);
        return true;
      },
      invalidatePaths: async (paths) => {
        invalidations.push([...paths]);
      },
    }),
  });

beforeEach(() => {
  store.clear();
  invalidations.length = 0;
});

setupDatabaseAdapterTestSuite({
  name: "blob snapshot adapter v2",
  createAdapter: createMemoryAdapter,
  migrate: () => undefined,
  reset: () => {
    store.clear();
    invalidations.length = 0;
  },
  dispose: () => undefined,
  capabilities: { transaction: true },
});

setupDatabaseClientTestSuite({
  name: "blob snapshot aggregate client",
  createAdapter: createMemoryAdapter,
  createClient: createDatabaseClient,
  migrate: () => undefined,
  reset: () => {
    store.clear();
    invalidations.length = 0;
  },
  dispose: () => undefined,
});
