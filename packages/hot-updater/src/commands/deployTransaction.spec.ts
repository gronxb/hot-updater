import type {
  Bundle,
  DatabaseClient,
  DatabaseMutationClient,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { prepareAndCommitBundles } from "./deployTransaction";

const createBundle = (id: string, platform: Bundle["platform"]): Bundle => ({
  channel: "production",
  enabled: true,
  fileHash: `${id}-hash`,
  fingerprintHash: null,
  gitCommitHash: null,
  id,
  message: null,
  platform,
  shouldForceUpdate: false,
  storageUri: `storage://bundle/${id}`,
  targetAppVersion: "1.0.x",
});

const createTransactionlessClient = () => {
  const insertBundle = vi.fn(async (_bundle: Bundle): Promise<void> => {});
  const mutationClient: DatabaseMutationClient = {
    deleteBundleById: async (_bundleId) => {},
    getBundleById: async (_bundleId) => null,
    getBundles: async () => ({
      data: [],
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: 0,
        totalPages: 0,
      },
    }),
    getChannels: async () => [],
    insertChannel: async ({ row }) => ({ row, inserted: true }),
    getUpdateInfo: async (_args) => null,
    insertBundle,
    updateBundleById: async (_bundleId, _update) => {},
  };
  const database: DatabaseClient = {
    ...mutationClient,
    deleteChannel: async () => ({ deleted: true }),
    mutate: (operation) => operation(mutationClient),
  };

  return { database, insertBundle };
};

describe("prepareAndCommitBundles", () => {
  it("commits multiple bundles through one mutation boundary", async () => {
    const { database, insertBundle } = createTransactionlessClient();
    const bundles = [
      createBundle("bundle-ios", "ios"),
      createBundle("bundle-android", "android"),
    ];

    const deployment = prepareAndCommitBundles({
      database,
      prepare: async (persistBundle) => {
        for (const bundle of bundles) await persistBundle(bundle);
        return bundles.map(({ id }) => id);
      },
    });

    await expect(deployment).resolves.toEqual(["bundle-ios", "bundle-android"]);
    expect(insertBundle).toHaveBeenCalledTimes(2);
  });

  it("commits one bundle without requiring a multi-bundle transaction", async () => {
    const { database, insertBundle } = createTransactionlessClient();
    const bundle = createBundle("bundle-ios", "ios");

    const result = await prepareAndCommitBundles({
      database,
      prepare: async (persistBundle) => {
        await persistBundle(bundle);
        return [bundle.id];
      },
    });

    expect(result).toEqual([bundle.id]);
    expect(insertBundle).toHaveBeenCalledOnce();
  });
});
