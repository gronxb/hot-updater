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

const patch = (
  bundleId: string,
  baseBundleId: string,
  orderIndex: number,
): DatabaseBundlePatch => ({
  id: `${bundleId}:${baseBundleId}`,
  bundleId,
  baseBundleId,
  baseFileHash: `base-${baseBundleId}`,
  patchFileHash: `patch-${bundleId}-${baseBundleId}`,
  patchStorageUri: `s3://bucket/${bundleId}-${baseBundleId}.patch`,
  orderIndex,
});

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

  it("clears staged mutations after failed commits", async () => {
    let insertAttempts = 0;
    const onDatabaseUpdated = vi.fn();
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      connect: (): DatabasePluginCore => ({
        bundles: {
          getById: async () => null,
          list: async () => emptyPage<DatabaseBundleRecord>(),
          insert: async () => {
            insertAttempts += 1;
            throw new Error("insert failed");
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
    })({}, { onDatabaseUpdated });

    await plugin.bundles.insert({ bundle: baseBundle });
    await expect(
      plugin.bundles.getById({ bundleId: baseBundle.id }),
    ).resolves.toStrictEqual(baseBundle);

    await expect(plugin.commit()).rejects.toThrow("insert failed");

    await expect(
      plugin.bundles.getById({ bundleId: baseBundle.id }),
    ).resolves.toBeNull();
    await expect(plugin.commit()).resolves.toBeUndefined();
    expect(insertAttempts).toBe(1);
    expect(onDatabaseUpdated).not.toHaveBeenCalled();
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

  it("resolves promise-like connect results before creating a runtime", async () => {
    const core: DatabasePluginCore = {
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
    };
    const connect = (() => ({
      then: (resolve: (value: DatabasePluginCore) => void) => resolve(core),
    })) as () => Promise<DatabasePluginCore>;

    const plugin = await createDatabasePlugin({
      name: "thenable-plugin",
      connect,
    })({});

    expect(plugin.name).toBe("thenable-plugin");
    await expect(
      plugin.bundles.getById({ bundleId: baseBundle.id }),
    ).resolves.toBeNull();
  });

  it("reads staged bundle updates before commit and updates list metadata", async () => {
    const persistedBundles: DatabaseBundleRecord[] = [baseBundle];
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      connect: (): DatabasePluginCore => ({
        bundles: {
          getById: async ({ bundleId }) =>
            persistedBundles.find((bundle) => bundle.id === bundleId) ?? null,
          list: async ({ where, limit }) => {
            const data = persistedBundles
              .filter(
                (bundle) =>
                  where?.channel === undefined ||
                  bundle.channel === where.channel,
              )
              .slice(0, limit);
            return {
              data,
              pagination: {
                total: data.length,
                currentPage: 1,
                totalPages: data.length === 0 ? 0 : 1,
                hasNextPage: false,
                hasPreviousPage: false,
                nextCursor: null,
                previousCursor: null,
              },
            };
          },
          insert: async ({ bundle }) => {
            persistedBundles.push(bundle);
          },
          update: async ({ bundleId, patch }) => {
            const index = persistedBundles.findIndex(
              (bundle) => bundle.id === bundleId,
            );
            if (index >= 0) {
              persistedBundles[index] = {
                ...persistedBundles[index]!,
                ...patch,
              };
            }
          },
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

    await plugin.bundles.update({
      bundleId: baseBundle.id,
      patch: {
        channel: "staging",
        message: "Staged message",
      },
    });

    await expect(
      plugin.bundles.getById({ bundleId: baseBundle.id }),
    ).resolves.toMatchObject({
      channel: "staging",
      message: "Staged message",
    });
    await expect(
      plugin.bundles.list({
        where: { channel: "production" },
        limit: 10,
      }),
    ).resolves.toMatchObject({
      data: [],
      pagination: {
        total: 0,
        totalPages: 0,
      },
    });
    await expect(
      plugin.bundles.list({
        where: { channel: "staging" },
        limit: 10,
      }),
    ).resolves.toMatchObject({
      data: [
        expect.objectContaining({
          id: baseBundle.id,
          channel: "staging",
        }),
      ],
      pagination: {
        total: 1,
        totalPages: 1,
      },
    });
    expect(persistedBundles[0]?.channel).toBe("production");

    await plugin.commit();

    expect(persistedBundles[0]).toMatchObject({
      channel: "staging",
      message: "Staged message",
    });
  });

  it("updates staged patch pagination metadata for off-page deletes and replacements", async () => {
    const persistedPatches = [
      patch("bundle-1", "base-1", 0),
      patch("bundle-2", "base-2", 1),
      patch("bundle-3", "base-3", 2),
    ];
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      connect: (): DatabasePluginCore => ({
        bundles: {
          getById: async () => null,
          list: async () => emptyPage<DatabaseBundleRecord>(),
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          list: async ({ where, limit, cursor }) => {
            const filtered = persistedPatches.filter((item) => {
              if (where?.bundleId !== undefined) {
                return item.bundleId === where.bundleId;
              }
              if (where?.baseBundleId !== undefined) {
                return item.baseBundleId === where.baseBundleId;
              }
              return true;
            });
            const offset = cursor?.after
              ? filtered.findIndex((item) => item.id === cursor.after) + 1
              : 0;
            const data = filtered.slice(offset, offset + limit);
            return {
              data,
              pagination: {
                currentPage: 1,
                hasNextPage: offset + data.length < filtered.length,
                hasPreviousPage: offset > 0,
                nextCursor:
                  offset + data.length < filtered.length
                    ? (data.at(-1)?.id ?? null)
                    : null,
                previousCursor: null,
                total: filtered.length,
                totalPages:
                  limit > 0 && filtered.length > 0
                    ? Math.ceil(filtered.length / limit)
                    : 0,
              },
            };
          },
          replaceForBundle: async () => undefined,
          deleteForBundle: async () => undefined,
          deleteForBaseBundle: async () => undefined,
        },
      }),
    })({});

    await plugin.bundlePatches.deleteForBundle({ bundleId: "bundle-2" });
    await plugin.bundlePatches.replaceForBundle({
      bundleId: "bundle-4",
      patches: [patch("bundle-4", "base-4", 3), patch("bundle-4", "base-5", 4)],
    });

    await expect(
      plugin.bundlePatches.list({ limit: 1 }),
    ).resolves.toMatchObject({
      pagination: {
        total: 4,
        totalPages: 4,
      },
    });
  });

  it("clears stale patch pagination next cursors after off-page deletes", async () => {
    const persistedPatches = [
      patch("bundle-1", "base-1", 0),
      patch("bundle-2", "base-2", 1),
    ];
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      connect: (): DatabasePluginCore => ({
        bundles: {
          getById: async () => null,
          list: async () => emptyPage<DatabaseBundleRecord>(),
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          list: async ({ where, limit, cursor }) => {
            const filtered = persistedPatches.filter((item) => {
              if (where?.bundleId !== undefined) {
                return item.bundleId === where.bundleId;
              }
              if (where?.baseBundleId !== undefined) {
                return item.baseBundleId === where.baseBundleId;
              }
              return true;
            });
            const offset = cursor?.after
              ? filtered.findIndex((item) => item.id === cursor.after) + 1
              : 0;
            const data = filtered.slice(offset, offset + limit);
            return {
              data,
              pagination: {
                currentPage: 1,
                hasNextPage: offset + data.length < filtered.length,
                hasPreviousPage: offset > 0,
                nextCursor:
                  offset + data.length < filtered.length
                    ? (data.at(-1)?.id ?? null)
                    : null,
                previousCursor: null,
                total: filtered.length,
                totalPages:
                  limit > 0 && filtered.length > 0
                    ? Math.ceil(filtered.length / limit)
                    : 0,
              },
            };
          },
          replaceForBundle: async () => undefined,
          deleteForBundle: async () => undefined,
          deleteForBaseBundle: async () => undefined,
        },
      }),
    })({});

    await plugin.bundlePatches.deleteForBundle({ bundleId: "bundle-2" });

    await expect(
      plugin.bundlePatches.list({ limit: 1 }),
    ).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "bundle-1:base-1" })],
      pagination: {
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        nextCursor: null,
      },
    });
  });

  it("updates staged bundle event pagination metadata for appends", async () => {
    const persistedEvents: DatabaseBundleEvent[] = [
      {
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
      },
      {
        id: "0195a408-8f13-7d9b-8df4-000000000002",
        kind: "APP_READY",
        installId: "install-2",
        activeBundleId: baseBundle.id,
        platform: "ios",
        channel: "production",
        payload: {
          status: "STABLE",
          sdkVersion: "0.0.0",
          defaultChannel: "production",
          isChannelSwitched: false,
        },
      },
    ];
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      connect: (): DatabasePluginCore => ({
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
        bundleEvents: {
          list: async ({ limit }) => ({
            data: persistedEvents.slice(0, limit),
            pagination: {
              currentPage: 1,
              hasNextPage: persistedEvents.length > limit,
              hasPreviousPage: false,
              nextCursor:
                persistedEvents.length > limit
                  ? (persistedEvents.at(limit - 1)?.id ?? null)
                  : null,
              previousCursor: null,
              total: persistedEvents.length,
              totalPages:
                limit > 0 && persistedEvents.length > 0
                  ? Math.ceil(persistedEvents.length / limit)
                  : 0,
            },
          }),
          append: async () => undefined,
        },
      }),
    })({});

    await plugin.bundleEvents?.append({
      event: {
        kind: "APP_READY",
        installId: "install-3",
        activeBundleId: baseBundle.id,
        platform: "ios",
        channel: "production",
        payload: {
          status: "STABLE",
          sdkVersion: "0.0.0",
          defaultChannel: "production",
          isChannelSwitched: false,
        },
      },
    });

    await expect(
      plugin.bundleEvents?.list({ limit: 1 }),
    ).resolves.toMatchObject({
      pagination: {
        total: 3,
        totalPages: 3,
      },
    });
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
