import { describe, expect, it, vi } from "vitest";

import { createDatabasePlugin } from "./createDatabasePlugin";
import type {
  CursorPage,
  DatabaseBundleEvent,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
  DatabasePluginCore,
} from "./types";

const emptyPage = <T>(data: T[] = []): CursorPage<T> => ({
  data,
  pagination: {
    hasNextPage: false,
    hasPreviousPage: false,
    nextCursor: null,
    previousCursor: null,
  },
});

const emptyPatchPage = () => emptyPage<DatabaseBundlePatch>();

const baseBundle: DatabaseBundleRecord = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "hash",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Initial message",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: ["device-1", "device-2"],
};

describe("createDatabasePlugin", () => {
  it("creates a resource runtime from name plus connect", async () => {
    const insertedBundles: DatabaseBundleRecord[] = [];
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      connect: (): DatabasePluginCore => ({
        bundles: {
          getById: async ({ bundleId }) =>
            insertedBundles.find((bundle) => bundle.id === bundleId) ?? null,
          list: async () => emptyPage(insertedBundles),
          insert: async ({ bundle }) => {
            insertedBundles.push(bundle);
          },
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          list: async () => emptyPatchPage(),
          replaceForBundle: async () => undefined,
          deleteForBundle: async () => undefined,
          deleteForBaseBundle: async () => undefined,
        },
      }),
    })({});

    await plugin.bundles.insert({ bundle: baseBundle });

    await expect(
      plugin.bundles.getById({ bundleId: baseBundle.id }),
    ).resolves.toStrictEqual(baseBundle);
    expect(insertedBundles).toHaveLength(0);

    await plugin.commit();

    expect(insertedBundles).toStrictEqual([baseBundle]);
  });

  it("returns a promise when connect is async", async () => {
    const connect = vi.fn(async () => ({
      bundles: {
        getById: async () => null,
        list: async () => emptyPage<DatabaseBundleRecord>(),
        insert: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      },
      bundlePatches: {
        list: async () => emptyPatchPage(),
        replaceForBundle: async () => undefined,
        deleteForBundle: async () => undefined,
        deleteForBaseBundle: async () => undefined,
      },
    }));

    const plugin = await createDatabasePlugin({
      name: "async-plugin",
      connect,
    })({});

    expect(plugin.name).toBe("async-plugin");
    expect(plugin.bundleEvents).toBeUndefined();
    expect(connect).toHaveBeenCalledWith({});
  });

  it("rejects bundle event mutations when the provider omits bundleEvents", async () => {
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      connect: () => ({
        bundles: {
          getById: async () => null,
          list: async () => emptyPage<DatabaseBundleRecord>(),
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          list: async () => emptyPatchPage(),
          replaceForBundle: async () => undefined,
          deleteForBundle: async () => undefined,
          deleteForBaseBundle: async () => undefined,
        },
      }),
    })({});

    await expect(
      plugin.commit({
        batch: {
          mutations: [
            {
              kind: "bundleEvent.append",
              event: {
                id: "0195a408-8f13-7d9b-8df4-000000000001",
                kind: "APP_READY",
                installId: "install-1",
                activeBundleId: baseBundle.id,
                platform: "ios",
                channel: "production",
                payload: {
                  status: "STABLE",
                  sdkVersion: "0.0.0",
                  defaultChannel: "production",
                  isChannelSwitched: false,
                },
              } satisfies DatabaseBundleEvent,
            },
          ],
        },
      }),
    ).rejects.toThrow("bundleEvents");
  });
});
