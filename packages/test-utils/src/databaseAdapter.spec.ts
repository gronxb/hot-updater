import {
  createBlobDatabaseAdapter,
  createDatabaseClient,
} from "@hot-updater/plugin-core";
import { beforeEach } from "vitest";

import { setupDatabaseAdapterTestSuite } from "./setupDatabaseAdapterTestSuite";
import { setupDatabaseClientTestSuite } from "./setupDatabaseClientTestSuite";

type MemoryConfig = {
  readonly store: Map<string, unknown>;
  readonly invalidations: string[][];
};

const store = new Map<string, unknown>();
const invalidations: string[][] = [];

const createMemoryAdapter = () =>
  createBlobDatabaseAdapter<MemoryConfig>({
    name: "memoryBlobDatabase",
    factory: (input) => ({
      apiBasePath: "/api/check-update",
      listObjects: async (prefix) =>
        [...input.store.keys()].filter((key) => key.startsWith(prefix)),
      loadObject: async (key) => input.store.get(key) ?? null,
      uploadObject: async (key, data) => {
        input.store.set(key, data);
      },
      invalidatePaths: async (paths) => {
        input.invalidations.push([...paths]);
      },
    }),
  })({ store, invalidations });

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
