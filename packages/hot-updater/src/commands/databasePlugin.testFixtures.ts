import type { Bundle } from "@hot-updater/plugin-core";
import {
  BLOB_DATABASE_SNAPSHOT_KEY,
  bundleToPatchRows,
  bundleToRow,
  createBlobDatabasePlugin,
  createDatabaseClient,
  type BlobDatabaseSnapshot,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { vi } from "vitest";

const emptySnapshot = (): BlobDatabaseSnapshot => ({
  version: 2,
  bundles: [],
  bundle_patches: [],
  bundle_events: [],
});

export const createDatabasePluginHarness = () => {
  let storedSnapshot: unknown = emptySnapshot();
  const storedObjects = new Map<string, unknown>();
  let pendingSnapshot: unknown = null;
  let pendingReadCount = 0;
  const readObject = async (key: string): Promise<unknown | null> => {
    if (key !== BLOB_DATABASE_SNAPSHOT_KEY) {
      return structuredClone(storedObjects.get(key) ?? null);
    }
    if (pendingSnapshot !== null) {
      if (pendingReadCount === 0) {
        storedSnapshot = pendingSnapshot;
        pendingSnapshot = null;
      } else {
        pendingReadCount -= 1;
      }
    }
    return structuredClone(storedSnapshot);
  };
  const writeObject = async (key: string, data: unknown): Promise<void> => {
    if (key !== BLOB_DATABASE_SNAPSHOT_KEY) {
      storedObjects.set(key, structuredClone(data));
      return;
    }
    if (pendingReadCount > 0) {
      pendingSnapshot = structuredClone(data);
    } else {
      storedSnapshot = structuredClone(data);
    }
  };
  const loadObject = vi.fn(readObject);
  const uploadObject = vi.fn(writeObject);
  const compareAndSwapObject = vi.fn(
    async (key: string, expected: unknown, data: unknown): Promise<boolean> => {
      const current = await readObject(key);
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      await writeObject(key, data);
      return true;
    },
  );
  const onUnmount = vi.fn(async (): Promise<void> => {});
  const basePlugin = createBlobDatabasePlugin({
    name: "test-database-v2",
    plugin: () => ({
      apiBasePath: "/api",
      invalidatePaths: async () => {},
      listObjects: async () => [],
      loadObject,
      uploadObject,
      compareAndSwapObject,
    }),
  });
  const plugin: DatabasePlugin = { ...basePlugin, onUnmount };

  return {
    plugin,
    compareAndSwapObject,
    loadObject,
    onUnmount,
    uploadObject,
    bundles: async (): Promise<Bundle[]> =>
      (
        await createDatabaseClient(plugin).getBundles({
          limit: 100,
        })
      ).data,
    delayNextSnapshotVisibility: (readCount: number): void => {
      pendingReadCount = readCount;
    },
    reset: (): void => {
      storedSnapshot = emptySnapshot();
      storedObjects.clear();
      pendingSnapshot = null;
      pendingReadCount = 0;
      loadObject.mockImplementation(readObject);
      uploadObject.mockImplementation(writeObject);
      compareAndSwapObject.mockImplementation(async (key, expected, data) => {
        const current = await readObject(key);
        if (JSON.stringify(current) !== JSON.stringify(expected)) {
          return false;
        }
        await writeObject(key, data);
        return true;
      });
    },
    setBundles: (bundles: readonly Bundle[]): void => {
      storedObjects.clear();
      storedSnapshot = {
        version: 2,
        bundles: bundles.map((bundle) => bundleToRow(bundle)),
        bundle_patches: bundles.flatMap(bundleToPatchRows),
        bundle_events: [],
      };
    },
  };
};
