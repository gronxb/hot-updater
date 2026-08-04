import {
  createBlobDatabasePlugin,
  createDatabaseClient,
} from "@hot-updater/plugin-core";
import { beforeEach } from "vitest";

import { setupDatabaseClientTestSuite } from "./setupDatabaseClientTestSuite";
import { setupDatabasePluginTestSuite } from "./setupDatabasePluginTestSuite";

const store = new Map<string, unknown>();
const invalidations: string[][] = [];

const createMemoryPlugin = () =>
  createBlobDatabasePlugin({
    name: "memoryBlobDatabase",
    plugin: () => ({
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

setupDatabasePluginTestSuite({
  name: "blob snapshot plugin v2",
  createPlugin: createMemoryPlugin,
  migrate: () => undefined,
  reset: () => {
    store.clear();
    invalidations.length = 0;
  },
  dispose: () => undefined,
});

setupDatabaseClientTestSuite({
  name: "blob snapshot aggregate client",
  createPlugin: createMemoryPlugin,
  createClient: createDatabaseClient,
  migrate: () => undefined,
  reset: () => {
    store.clear();
    invalidations.length = 0;
  },
  dispose: () => undefined,
});
