import type { Bundle } from "@hot-updater/plugin-core";
import {
  BLOB_DATABASE_SNAPSHOT_KEY,
  bundleToPatchRows,
  bundleToRow,
  createBlobDatabaseAdapter,
  createDatabaseClient,
  type BlobDatabaseSnapshot,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core";
import { vi } from "vitest";

const emptySnapshot = (): BlobDatabaseSnapshot => ({
  version: 2,
  bundles: [],
  bundle_patches: [],
  channels: [],
});

export const createDatabaseAdapterHarness = () => {
  let storedSnapshot: unknown = emptySnapshot();
  let pendingSnapshot: unknown = null;
  let pendingReadCount = 0;
  const readObject = async (key: string): Promise<unknown | null> => {
    if (key !== BLOB_DATABASE_SNAPSHOT_KEY) return null;
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
    if (key === BLOB_DATABASE_SNAPSHOT_KEY) {
      if (pendingReadCount > 0) {
        pendingSnapshot = structuredClone(data);
      } else {
        storedSnapshot = structuredClone(data);
      }
    }
  };
  const loadObject = vi.fn(readObject);
  const uploadObject = vi.fn(writeObject);
  const onUnmount = vi.fn(async (): Promise<void> => {});
  const baseAdapter = createBlobDatabaseAdapter({
    name: "test-database-v2",
    adapter: () => ({
      apiBasePath: "/api",
      invalidatePaths: async () => {},
      listObjects: async () => [],
      loadObject,
      uploadObject,
    }),
  });
  const adapter: DatabaseAdapter = { ...baseAdapter, onUnmount };

  return {
    adapter,
    loadObject,
    onUnmount,
    uploadObject,
    bundles: async (): Promise<Bundle[]> =>
      (
        await createDatabaseClient(adapter).getBundles({
          limit: 100,
        })
      ).data,
    delayNextSnapshotVisibility: (readCount: number): void => {
      pendingReadCount = readCount;
    },
    reset: (): void => {
      storedSnapshot = emptySnapshot();
      pendingSnapshot = null;
      pendingReadCount = 0;
      loadObject.mockImplementation(readObject);
      uploadObject.mockImplementation(writeObject);
    },
    setBundles: (bundles: readonly Bundle[]): void => {
      storedSnapshot = {
        version: 2,
        bundles: bundles.map((bundle) => bundleToRow(bundle, bundle.channel)),
        bundle_patches: bundles.flatMap(bundleToPatchRows),
        channels: [...new Set(bundles.map(({ channel }) => channel))].map(
          (name) => ({ id: name, name }),
        ),
      };
    },
  };
};
