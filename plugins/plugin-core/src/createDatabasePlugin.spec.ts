import { describe, expect, it, vi } from "vitest";

import { createDatabasePlugin } from "./createDatabasePlugin";
import type {
  DatabaseBundleEvent,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
  DatabasePluginCore,
} from "./types";

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
          findMany: async ({ window }) =>
            insertedBundles.slice(window.offset, window.offset + window.limit),
          count: async () => insertedBundles.length,
          insert: async ({ bundle }) => {
            insertedBundles.push(bundle);
          },
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          findMany: async () => [],
          count: async () => 0,
          getById: async () => null,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
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

  it("keeps staged mutations after failed commits", async () => {
    let insertAttempts = 0;
    const onDatabaseUpdated = vi.fn();
    let shouldFail = true;
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      connect: (): DatabasePluginCore => ({
        bundles: {
          getById: async () => null,
          findMany: async () => [],
          count: async () => 0,
          insert: async () => {
            insertAttempts += 1;
            if (shouldFail) {
              throw new Error("insert failed");
            }
          },
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          findMany: async () => [],
          count: async () => 0,
          getById: async () => null,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
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
    ).resolves.toStrictEqual(baseBundle);
    shouldFail = false;
    await expect(plugin.commit()).resolves.toBeUndefined();
    expect(insertAttempts).toBe(2);
    expect(onDatabaseUpdated).toHaveBeenCalledTimes(1);
  });

  it("returns a promise when connect is async", async () => {
    const connect = vi.fn(async () => ({
      bundles: {
        getById: async () => null,
        findMany: async () => [],
        count: async () => 0,
        insert: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      },
      bundlePatches: {
        findMany: async () => [],
        count: async () => 0,
        getById: async () => null,
        insert: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
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
        findMany: async () => [],
        count: async () => 0,
        insert: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      },
      bundlePatches: {
        findMany: async () => [],
        count: async () => 0,
        getById: async () => null,
        insert: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
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
          findMany: async ({ where, window }) =>
            persistedBundles
              .filter(
                (bundle) =>
                  where?.channel === undefined ||
                  bundle.channel === where.channel,
              )
              .slice(window.offset, window.offset + window.limit),
          count: async ({ where }) =>
            persistedBundles.filter(
              (bundle) =>
                where?.channel === undefined ||
                bundle.channel === where.channel,
            ).length,
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
          findMany: async () => [],
          count: async () => 0,
          getById: async () => null,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
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

  it("builds runtime bundle pages from provider findMany and count primitives", async () => {
    const persistedBundles: DatabaseBundleRecord[] = [
      baseBundle,
      {
        ...baseBundle,
        id: "0195a408-8f13-7d9b-8df4-123456789abd",
        channel: "staging",
      },
    ];
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      connect: (): DatabasePluginCore => ({
        bundles: {
          getById: async ({ bundleId }) =>
            persistedBundles.find((bundle) => bundle.id === bundleId) ?? null,
          findMany: async ({ where, window }) =>
            persistedBundles
              .filter(
                (bundle) =>
                  where?.channel === undefined ||
                  bundle.channel === where.channel,
              )
              .slice(window.offset, window.offset + window.limit),
          count: async ({ where }) =>
            persistedBundles.filter(
              (bundle) =>
                where?.channel === undefined ||
                bundle.channel === where.channel,
            ).length,
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
          findMany: async () => [],
          count: async () => 0,
          getById: async () => null,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
      }),
    })({});

    await plugin.bundles.update({
      bundleId: baseBundle.id,
      patch: { channel: "staging" },
    });

    await expect(
      plugin.bundles.list({
        where: { channel: "staging" },
        limit: 1,
      }),
    ).resolves.toMatchObject({
      data: [
        expect.objectContaining({
          id: "0195a408-8f13-7d9b-8df4-123456789abd",
        }),
      ],
      pagination: {
        total: 2,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      },
    });
    await expect(
      plugin.bundles.list({
        where: { channel: "staging" },
        limit: 2,
      }),
    ).resolves.toMatchObject({
      data: [
        expect.objectContaining({
          id: "0195a408-8f13-7d9b-8df4-123456789abd",
        }),
        expect.objectContaining({ id: baseBundle.id }),
      ],
      pagination: {
        total: 2,
        totalPages: 1,
        hasNextPage: false,
      },
    });
    expect(persistedBundles[0]?.channel).toBe("production");
  });

  it("handles low-level pagination boundaries without provider cursors", async () => {
    const persistedPatches = [
      patch("bundle-1", "base-1", 0),
      patch("bundle-2", "base-2", 0),
      patch("bundle-3", "base-3", 1),
    ];
    const sortedPatches = () =>
      [...persistedPatches].sort(
        (left, right) =>
          left.orderIndex - right.orderIndex ||
          (left.id ?? "").localeCompare(right.id ?? ""),
      );
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      connect: (): DatabasePluginCore => ({
        bundles: {
          getById: async () => null,
          findMany: async () => [],
          count: async () => 0,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          getById: async ({ patchId }) =>
            persistedPatches.find((item) => item.id === patchId) ?? null,
          findMany: async ({ window }) =>
            sortedPatches().slice(window.offset, window.offset + window.limit),
          count: async () => persistedPatches.length,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
      }),
    })({});

    await expect(
      plugin.bundlePatches.list({
        limit: 1,
        cursor: { after: "not-a-core-cursor" },
        orderBy: { field: "orderIndex", direction: "asc" },
      }),
    ).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "bundle-1:base-1" })],
      pagination: {
        total: 3,
        hasNextPage: true,
        hasPreviousPage: false,
      },
    });

    const firstPage = await plugin.bundlePatches.list({
      limit: 2,
      orderBy: { field: "orderIndex", direction: "asc" },
    });

    expect(firstPage.data.map((item) => item.id)).toStrictEqual([
      "bundle-1:base-1",
      "bundle-2:base-2",
    ]);

    await expect(
      plugin.bundlePatches.list({
        limit: 2,
        cursor: { after: firstPage.pagination.nextCursor ?? undefined },
        orderBy: { field: "orderIndex", direction: "asc" },
      }),
    ).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "bundle-3:base-3" })],
      pagination: {
        total: 3,
        hasNextPage: false,
        hasPreviousPage: true,
      },
    });
  });

  it("treats bundlePatches as generic staged CRUD resources", async () => {
    const persistedPatches: DatabaseBundlePatch[] = [];
    const firstPatch = patch("bundle-1", "base-1", 0);
    const patchId = firstPatch.id ?? `${firstPatch.bundleId}:base-1`;
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      connect: (): DatabasePluginCore => ({
        bundles: {
          getById: async () => null,
          findMany: async () => [],
          count: async () => 0,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          getById: async ({ patchId }) =>
            persistedPatches.find((item) => item.id === patchId) ?? null,
          findMany: async ({ window }) =>
            persistedPatches.slice(window.offset, window.offset + window.limit),
          count: async () => persistedPatches.length,
          insert: async ({ patch }) => {
            persistedPatches.push(patch);
          },
          update: async ({ patchId, patch }) => {
            const index = persistedPatches.findIndex(
              (item) => item.id === patchId,
            );
            if (index >= 0) {
              persistedPatches[index] = {
                ...persistedPatches[index]!,
                ...patch,
              };
            }
          },
          delete: async ({ patchId }) => {
            const index = persistedPatches.findIndex(
              (item) => item.id === patchId,
            );
            if (index >= 0) {
              persistedPatches.splice(index, 1);
            }
          },
        },
      }),
    })({});

    await plugin.bundlePatches.insert({ patch: firstPatch });

    await expect(plugin.bundlePatches.getById({ patchId })).resolves.toEqual(
      firstPatch,
    );
    await expect(
      plugin.bundlePatches.list({ limit: 10 }),
    ).resolves.toMatchObject({
      data: [firstPatch],
    });
    expect(persistedPatches).toStrictEqual([]);

    await plugin.commit();

    expect(persistedPatches).toStrictEqual([firstPatch]);

    await plugin.bundlePatches.update({
      patchId,
      patch: { orderIndex: 2 },
    });

    await expect(
      plugin.bundlePatches.getById({ patchId }),
    ).resolves.toMatchObject({
      orderIndex: 2,
    });
    expect(persistedPatches[0]?.orderIndex).toBe(0);

    await plugin.commit();

    expect(persistedPatches[0]?.orderIndex).toBe(2);

    await plugin.bundlePatches.delete({ patchId });

    await expect(plugin.bundlePatches.getById({ patchId })).resolves.toBeNull();
    expect(persistedPatches).toHaveLength(1);

    await plugin.commit();

    expect(persistedPatches).toStrictEqual([]);
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
          findMany: async () => [],
          count: async () => 0,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          findMany: async ({ where, window }) => {
            const filtered = persistedPatches.filter((item) => {
              if (where?.bundleId !== undefined) {
                return item.bundleId === where.bundleId;
              }
              if (where?.baseBundleId !== undefined) {
                return item.baseBundleId === where.baseBundleId;
              }
              return true;
            });
            return filtered.slice(window.offset, window.offset + window.limit);
          },
          count: async ({ where }) =>
            persistedPatches.filter((item) => {
              if (where?.bundleId !== undefined) {
                return item.bundleId === where.bundleId;
              }
              if (where?.baseBundleId !== undefined) {
                return item.baseBundleId === where.baseBundleId;
              }
              return true;
            }).length,
          getById: async ({ patchId }) =>
            persistedPatches.find((item) => item.id === patchId) ?? null,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
      }),
    })({});

    await plugin.bundlePatches.delete({ patchId: "bundle-2:base-2" });
    await plugin.bundlePatches.insert({
      patch: patch("bundle-4", "base-4", 3),
    });
    await plugin.bundlePatches.insert({
      patch: patch("bundle-4", "base-5", 4),
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
          findMany: async () => [],
          count: async () => 0,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          findMany: async ({ where, window }) => {
            const filtered = persistedPatches.filter((item) => {
              if (where?.bundleId !== undefined) {
                return item.bundleId === where.bundleId;
              }
              if (where?.baseBundleId !== undefined) {
                return item.baseBundleId === where.baseBundleId;
              }
              return true;
            });
            return filtered.slice(window.offset, window.offset + window.limit);
          },
          count: async ({ where }) =>
            persistedPatches.filter((item) => {
              if (where?.bundleId !== undefined) {
                return item.bundleId === where.bundleId;
              }
              if (where?.baseBundleId !== undefined) {
                return item.baseBundleId === where.baseBundleId;
              }
              return true;
            }).length,
          getById: async ({ patchId }) =>
            persistedPatches.find((item) => item.id === patchId) ?? null,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
      }),
    })({});

    await plugin.bundlePatches.delete({ patchId: "bundle-2:base-2" });

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
          findMany: async () => [],
          count: async () => 0,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          findMany: async () => [],
          count: async () => 0,
          getById: async () => null,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundleEvents: {
          findMany: async ({ window }) =>
            persistedEvents.slice(window.offset, window.offset + window.limit),
          count: async () => persistedEvents.length,
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
          findMany: async () => [],
          count: async () => 0,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        },
        bundlePatches: {
          findMany: async () => [],
          count: async () => 0,
          getById: async () => null,
          insert: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
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
