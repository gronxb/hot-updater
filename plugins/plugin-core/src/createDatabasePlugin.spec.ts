import { describe, expect, it, vi } from "vitest";

import {
  type AbstractDatabasePlugin,
  createDatabasePlugin,
} from "./createDatabasePlugin";
import { deleteBundleById } from "./deleteBundleById";
import type {
  Bundle,
  DatabaseBundleChange,
  DatabaseChangeBucket,
  DatabaseAnalyticsOperations,
  DatabaseCommitInput,
  DatabaseChanges,
  DatabasePlugin,
  GetBundlesArgs,
  HotUpdaterContext,
  RequestEnvContext,
} from "./types";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

type Expect<T extends true> = T;

type AnalyticsOperationKeys = keyof NonNullable<DatabasePlugin["analytics"]>;
type AnalyticsEventOperationKeys = keyof NonNullable<
  DatabasePlugin["analyticsEvents"]
>;
type BundlePatchOperationKeys = keyof NonNullable<
  DatabasePlugin["bundlePatches"]
>;
type BundleOperationKeys = keyof DatabasePlugin["bundles"];
type DatabaseOperationKeys = keyof DatabasePlugin;
type DatabaseChangeKeys = keyof DatabaseChanges;
type IngestKeyOperationKeys = keyof NonNullable<DatabasePlugin["ingestKeys"]>;
type UpdatesOperationKeys = keyof NonNullable<DatabasePlugin["updates"]>;
type ExpectedAnalyticsOperationKeys =
  | "getLifecycleMetrics"
  | "getTelemetryKeyCredential"
  | "insertLifecycleEvent"
  | "setTelemetryKeyActive"
  | "upsertTelemetryKeyCredential";
type ExpectedAppendOnlyOperationKeys = "append";
type ExpectedBundleOperationKeys = "append" | "get" | "list" | "update";
type ExpectedDatabaseOperationKeys =
  | "analytics"
  | "analyticsEvents"
  | "bundlePatches"
  | "bundles"
  | "channels"
  | "commit"
  | "ingestKeys"
  | "name"
  | "onUnmount"
  | "updates";
type ExpectedDatabaseChangeKeys =
  | "analyticsEvents"
  | "bundlePatches"
  | "bundles"
  | "ingestKeys";

type _AnalyticsOperationsMatchDatabasePlugin = Expect<
  Equal<
    NonNullable<DatabasePlugin["analytics"]>,
    DatabaseAnalyticsOperations<unknown>
  >
>;
type _AnalyticsOperationsExposeOnlyStorageKeys = Expect<
  Equal<AnalyticsOperationKeys, ExpectedAnalyticsOperationKeys>
>;
type _AnalyticsEventOperationsExposeOnlyAppend = Expect<
  Equal<AnalyticsEventOperationKeys, ExpectedAppendOnlyOperationKeys>
>;
type _BundlePatchOperationsExposeOnlyAppend = Expect<
  Equal<BundlePatchOperationKeys, ExpectedAppendOnlyOperationKeys>
>;
type _BundleOperationsExposeOnlyTableVerbs = Expect<
  Equal<BundleOperationKeys, ExpectedBundleOperationKeys>
>;
type _IngestKeyOperationsExposeOnlyAppendAndUpdate = Expect<
  Equal<IngestKeyOperationKeys, "append" | "update">
>;
type _UpdatesOperationsExposeOnlyCheck = Expect<
  Equal<UpdatesOperationKeys, "check">
>;
type _DatabasePluginExposesOnlyRootCommit = Expect<
  Equal<DatabaseOperationKeys, ExpectedDatabaseOperationKeys>
>;
type _DatabasePluginExposesRootCommit = Expect<
  Equal<
    Parameters<DatabasePlugin["commit"]>,
    [HotUpdaterContext | undefined, DatabaseCommitInput]
  >
>;
type _DatabasePluginCommitInputIsRootOnly = Expect<
  Equal<
    Parameters<AbstractDatabasePlugin["commit"]>,
    [HotUpdaterContext | undefined, { readonly changes: DatabaseChanges }]
  >
>;
type _DatabaseChangesExposeGroupedTablePayload = Expect<
  Equal<DatabaseChangeKeys, ExpectedDatabaseChangeKeys>
>;

const baseBundle: Bundle = {
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

type TestFactoryMethods = AbstractDatabasePlugin["bundles"] & {
  commit: AbstractDatabasePlugin["commit"];
  getChannels: AbstractDatabasePlugin["channels"]["getChannels"];
  onUnmount?: AbstractDatabasePlugin["onUnmount"];
  supportedChangeBuckets?: AbstractDatabasePlugin["supportedChangeBuckets"];
  updates?: AbstractDatabasePlugin["updates"];
};

const nested = ({
  commit,
  getChannels,
  onUnmount,
  supportedChangeBuckets,
  updates,
  ...bundles
}: TestFactoryMethods): AbstractDatabasePlugin => ({
  bundles,
  commit,
  channels: { getChannels },
  ...(onUnmount ? { onUnmount } : {}),
  ...(supportedChangeBuckets ? { supportedChangeBuckets } : {}),
  ...(updates ? { updates } : {}),
});

const expectedCommitCall = (bundles: readonly DatabaseBundleChange[]) =>
  [
    undefined,
    {
      changes: {
        analyticsEvents: [],
        bundlePatches: [],
        bundles,
        ingestKeys: [],
      },
    },
  ] as const;

describe("createDatabasePlugin", () => {
  it("groups database methods by concern", async () => {
    const commit = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () => ({
        bundles: {
          get: async (_context, { id: bundleId }) =>
            bundleId === baseBundle.id ? baseBundle : null,
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
        },
        commit,
        channels: {
          getChannels: async () => ["production"],
        },
      }),
    })({})();

    await plugin.bundles.update(undefined, {
      id: baseBundle.id,
      data: { enabled: false },
    });
    await expect(plugin.channels.getChannels()).resolves.toEqual([
      "production",
    ]);
    await plugin.commit(undefined, {});

    expect(commit).toHaveBeenCalledWith(
      ...expectedCommitCall([
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
          },
        },
      ]),
    );
  });

  it("commits grouped table changes through the root database commit", async () => {
    const commit = vi.fn();
    const context = {
      request: new Request("https://updates.example.com/check"),
    };
    const bundlePatch = {
      bundleId: baseBundle.id,
      baseBundleId: "0195a408-8f13-7d9b-8df4-base00000001",
      baseFileHash: "base-hash",
      patchFileHash: "patch-hash",
      patchStorageUri: "s3://bucket/patches/patch-1.zip",
    };
    const analyticsEvent = {
      bundleId: baseBundle.id,
      channel: "production",
      eventId: "event-1",
      installId: "install-1",
      observedAt: "2026-07-04T00:00:00.000Z",
      platform: "ios",
      status: "ACTIVE",
    } as const;
    const ingestKey = {
      active: true,
      keyHash: "sha256:telemetry-key",
      telemetryKeySuffix: "key",
    };

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundleId === baseBundle.id ? baseBundle : null,
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          supportedChangeBuckets: [
            "bundles",
            "bundlePatches",
            "analyticsEvents",
            "ingestKeys",
          ],
          commit,
        }),
    })({})();

    await plugin.bundles.append(context, { data: baseBundle });
    await plugin.bundlePatches?.append(context, { data: bundlePatch });
    await plugin.analyticsEvents?.append(context, { data: analyticsEvent });
    await plugin.ingestKeys?.append(context, { data: ingestKey });
    await plugin.ingestKeys?.update(context, {
      id: "default",
      data: { telemetryKeySuffix: "rotated" },
    });
    await plugin.commit(context, {});
    await plugin.commit(context, {});

    expect(commit).toHaveBeenNthCalledWith(1, context, {
      changes: {
        analyticsEvents: [
          {
            operation: "insert",
            data: analyticsEvent,
          },
        ],
        bundlePatches: [
          {
            operation: "insert",
            data: bundlePatch,
          },
        ],
        bundles: [
          {
            operation: "insert",
            data: baseBundle,
          },
        ],
        ingestKeys: [
          {
            operation: "insert",
            data: ingestKey,
          },
          {
            operation: "update",
            data: {
              id: "default",
              data: { telemetryKeySuffix: "rotated" },
            },
          },
        ],
      },
    });
    expect(commit).toHaveBeenNthCalledWith(2, context, {
      changes: {
        analyticsEvents: [],
        bundlePatches: [],
        bundles: [],
        ingestKeys: [],
      },
    });
  });

  it("hides optional change tables unless the provider declares their buckets", async () => {
    const commit = vi.fn();
    const patch = {
      baseBundleId: "0195a408-8f13-7d9b-8df4-123456789aaa",
      baseFileHash: "base-hash",
      patchFileHash: "patch-hash",
      patchStorageUri: "s3://bucket/patches/patch-1.zip",
    };
    const bundleWithPatch = {
      ...baseBundle,
      patches: [patch],
    };

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundleId === bundleWithPatch.id ? bundleWithPatch : null,
          list: async () => ({
            data: [bundleWithPatch],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          commit,
        }),
    })({})();

    expect(Object.keys(plugin)).not.toContain("bundlePatches");
    expect(Object.keys(plugin)).not.toContain("analyticsEvents");
    expect(Object.keys(plugin)).not.toContain("ingestKeys");
    expect(plugin.bundlePatches).toBeUndefined();
    expect(plugin.analyticsEvents).toBeUndefined();
    expect(plugin.ingestKeys).toBeUndefined();

    await deleteBundleById(plugin, undefined, {
      id: bundleWithPatch.id,
      bundle: bundleWithPatch,
    });
    await plugin.commit(undefined, {});

    expect(commit).toHaveBeenCalledWith(undefined, {
      changes: {
        analyticsEvents: [],
        bundlePatches: [],
        bundles: [
          {
            operation: "delete",
            data: bundleWithPatch,
          },
        ],
        ingestKeys: [],
      },
    });
  });

  it("rejects unsupported staged buckets without clearing the unit of work", async () => {
    const commit = vi.fn();
    const context = {
      request: new Request("https://updates.example.com/check"),
    };
    const analyticsEvent = {
      bundleId: baseBundle.id,
      channel: "production",
      eventId: "event-1",
      installId: "install-1",
      observedAt: "2026-07-04T00:00:00.000Z",
      platform: "ios",
      status: "ACTIVE",
    } as const;
    let supportedBuckets: readonly DatabaseChangeBucket[] = [
      "bundles",
      "analyticsEvents",
    ];

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () => ({
        get supportedChangeBuckets() {
          return supportedBuckets;
        },
        bundles: {
          get: async (_context, { id: bundleId }) =>
            bundleId === baseBundle.id ? baseBundle : null,
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
        },
        channels: {
          getChannels: async () => ["production"],
        },
        commit,
      }),
    })({})();

    await plugin.analyticsEvents?.append(context, { data: analyticsEvent });
    supportedBuckets = ["bundles"];

    await expect(plugin.commit(context, {})).rejects.toThrow(
      'Database provider "test-plugin" does not support committing analyticsEvents changes.',
    );
    expect(commit).not.toHaveBeenCalled();

    supportedBuckets = ["bundles", "analyticsEvents"];
    await plugin.commit(context, {});

    expect(commit).toHaveBeenCalledWith(context, {
      changes: {
        analyticsEvents: [
          {
            operation: "insert",
            data: analyticsEvent,
          },
        ],
        bundlePatches: [],
        bundles: [],
        ingestKeys: [],
      },
    });
  });

  it("replaces targetCohorts instead of merging array items", async () => {
    const commit = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundleId === baseBundle.id ? baseBundle : null,
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          supportedChangeBuckets: ["bundles", "bundlePatches"],
          commit,
        }),
    })({})();

    await plugin.bundles.update(undefined, {
      id: baseBundle.id,
      data: {
        targetCohorts: ["device-2"],
      },
    });
    await plugin.commit(undefined, {});

    expect(commit).toHaveBeenCalledWith(
      ...expectedCommitCall([
        {
          operation: "update",
          data: {
            ...baseBundle,
            targetCohorts: ["device-2"],
          },
        },
      ]),
    );
  });

  it("preserves pending updates while allowing targetCohorts to be cleared", async () => {
    const commit = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundleId === baseBundle.id ? baseBundle : null,
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          supportedChangeBuckets: ["bundles", "bundlePatches"],
          commit,
        }),
    })({})();

    await plugin.bundles.update(undefined, {
      id: baseBundle.id,
      data: { enabled: false },
    });
    await plugin.bundles.update(undefined, {
      id: baseBundle.id,
      data: { targetCohorts: null },
    });
    await plugin.commit(undefined, {});

    expect(commit).toHaveBeenCalledWith(
      ...expectedCommitCall([
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
            targetCohorts: null,
          },
        },
      ]),
    );
  });

  it("preserves pending changes after a failed commit", async () => {
    const getBundleById = vi.fn(async (bundleId: string) =>
      bundleId === baseBundle.id ? baseBundle : null,
    );
    const commit = vi
      .fn()
      .mockRejectedValueOnce(new Error("commit failed"))
      .mockResolvedValueOnce(undefined);

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id }) => getBundleById(id),
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          commit,
        }),
    })({})();

    await plugin.bundles.update(undefined, {
      id: baseBundle.id,
      data: {
        enabled: false,
      },
    });
    await expect(plugin.commit(undefined, {})).rejects.toThrow("commit failed");
    await plugin.commit(undefined, {});

    expect(getBundleById).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenNthCalledWith(
      1,
      ...expectedCommitCall([
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
          },
        },
      ]),
    );
    expect(commit).toHaveBeenNthCalledWith(
      2,
      ...expectedCommitCall([
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
          },
        },
      ]),
    );
  });

  it("stages no-context updates without keeping read-only cache entries", async () => {
    const getBundleById = vi.fn(async (bundleId: string) =>
      bundleId === baseBundle.id ? baseBundle : null,
    );
    const commit = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id }) => getBundleById(id),
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          commit,
        }),
    })({})();

    await expect(
      plugin.bundles.get(undefined, { id: baseBundle.id }),
    ).resolves.toStrictEqual(baseBundle);
    await plugin.bundles.update(undefined, {
      id: baseBundle.id,
      data: {
        enabled: false,
      },
    });
    await plugin.commit(undefined, {});

    expect(getBundleById).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith(
      ...expectedCommitCall([
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
          },
        },
      ]),
    );
  });

  it("reads pending updates before commit in the same request context", async () => {
    const getBundleById = vi.fn(async (bundleId: string) =>
      bundleId === baseBundle.id ? baseBundle : null,
    );
    const context: RequestEnvContext<{ assetHost: string }> = {
      env: {
        assetHost: "https://assets.example.com",
      },
      request: new Request("https://updates.example.com"),
    };

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id }) => getBundleById(id),
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          commit: async () => undefined,
        }),
    })({})();

    await expect(
      plugin.bundles.get(context, { id: baseBundle.id }),
    ).resolves.toEqual(baseBundle);
    await plugin.bundles.update(context, {
      id: baseBundle.id,
      data: { enabled: false },
    });

    await expect(
      plugin.bundles.get(context, { id: baseBundle.id }),
    ).resolves.toEqual({
      ...baseBundle,
      enabled: false,
    });
    expect(getBundleById).toHaveBeenCalledTimes(1);
  });

  it("does not cache no-context bundle reads across logical calls", async () => {
    const nextBundle = {
      ...baseBundle,
      message: "Provider changed",
    };
    const getBundleById = vi
      .fn()
      .mockResolvedValueOnce(baseBundle)
      .mockResolvedValueOnce(nextBundle);

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id }) => getBundleById(id),
          list: async () => ({
            data: [nextBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          commit: async () => undefined,
        }),
    })({})();

    await expect(
      plugin.bundles.get(undefined, { id: baseBundle.id }),
    ).resolves.toEqual(baseBundle);
    await expect(
      plugin.bundles.get(undefined, { id: baseBundle.id }),
    ).resolves.toEqual(nextBundle);
    expect(getBundleById).toHaveBeenCalledTimes(2);
  });

  it("overlays pending updates and deletes onto bundle lists before commit", async () => {
    const deleteBundle = {
      ...baseBundle,
      id: "0195a408-8f13-7d9b-8df4-123456789abd",
      message: "Delete me",
    };
    const getBundleById = vi.fn(async (bundleId: string) => {
      if (bundleId === baseBundle.id) return baseBundle;
      if (bundleId === deleteBundle.id) return deleteBundle;
      return null;
    });

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id }) => getBundleById(id),
          list: async () => ({
            data: [baseBundle, deleteBundle],
            pagination: {
              total: 2,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          commit: async () => undefined,
        }),
    })({})();

    await plugin.bundles.update(undefined, {
      id: baseBundle.id,
      data: { enabled: false },
    });
    await deleteBundleById(plugin, undefined, {
      id: deleteBundle.id,
      bundle: deleteBundle,
    });

    await expect(
      plugin.bundles.list(undefined, {
        limit: 10,
        orderBy: { field: "id", direction: "asc" },
      }),
    ).resolves.toMatchObject({
      data: [
        {
          ...baseBundle,
          enabled: false,
        },
      ],
    });
  });

  it("stages bundle and bundle patch deletes through the shared deletion helper", async () => {
    const commit = vi.fn();
    const context: RequestEnvContext<{ assetHost: string }> = {
      env: {
        assetHost: "https://assets.example.com",
      },
      request: new Request("https://updates.example.com/delete"),
    };
    const patch = {
      baseBundleId: "0195a408-8f13-7d9b-8df4-123456789aaa",
      baseFileHash: "base-hash",
      patchFileHash: "patch-hash",
      patchStorageUri: "s3://bucket/patches/patch-1.zip",
    };
    const bundleWithPatch = {
      ...baseBundle,
      patches: [patch],
    };

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundleId === bundleWithPatch.id ? bundleWithPatch : null,
          list: async () => ({
            data: [bundleWithPatch],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          supportedChangeBuckets: ["bundles", "bundlePatches"],
          commit,
        }),
    })({})();

    await expect(
      deleteBundleById(plugin, context, { id: bundleWithPatch.id }),
    ).resolves.toEqual(bundleWithPatch);
    await expect(
      plugin.bundles.get(context, { id: bundleWithPatch.id }),
    ).resolves.toBeNull();
    await plugin.commit(context, {});

    expect(commit).toHaveBeenCalledWith(context, {
      changes: {
        analyticsEvents: [],
        bundlePatches: [
          {
            operation: "delete",
            data: {
              ...patch,
              bundleId: bundleWithPatch.id,
              id: `${bundleWithPatch.id}:${patch.baseBundleId}`,
              index: 0,
            },
          },
        ],
        bundles: [
          {
            operation: "delete",
            data: bundleWithPatch,
          },
        ],
        ingestKeys: [],
      },
    });
  });

  it("removes pending updates that no longer match bundle list filters", async () => {
    const context: RequestEnvContext<{ assetHost: string }> = {
      env: {
        assetHost: "https://assets.example.com",
      },
      request: new Request("https://updates.example.com"),
    };

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundleId === baseBundle.id ? baseBundle : null,
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          commit: async () => undefined,
        }),
    })({})();

    await plugin.bundles.update(context, {
      id: baseBundle.id,
      data: { enabled: false },
    });

    await expect(
      plugin.bundles.list(context, {
        limit: 10,
        where: { enabled: true },
      }),
    ).resolves.toMatchObject({
      data: [],
      pagination: {
        total: 0,
        totalPages: 0,
      },
    });
  });

  it("adds pending updates that now match bundle list filters", async () => {
    const disabledBundle = {
      ...baseBundle,
      enabled: false,
    };
    const context: RequestEnvContext<{ assetHost: string }> = {
      env: {
        assetHost: "https://assets.example.com",
      },
      request: new Request("https://updates.example.com"),
    };

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundleId === disabledBundle.id ? disabledBundle : null,
          list: async () => ({
            data: [],
            pagination: {
              total: 0,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 0,
            },
          }),
          getChannels: async () => ["production"],
          commit: async () => undefined,
        }),
    })({})();

    await plugin.bundles.update(context, {
      id: disabledBundle.id,
      data: { enabled: true },
    });

    await expect(
      plugin.bundles.list(context, {
        limit: 10,
        where: { enabled: true },
      }),
    ).resolves.toMatchObject({
      data: [baseBundle],
      pagination: {
        total: 1,
        totalPages: 1,
      },
    });
  });

  it("backfills bundle lists after pending deletes on a page boundary", async () => {
    const deletedBundle = {
      ...baseBundle,
      id: "0195a408-8f13-7d9b-8df4-123456789abd",
      message: "Delete me",
    };
    const nextBundle = {
      ...baseBundle,
      id: "0195a408-8f13-7d9b-8df4-123456789abe",
      message: "Backfill me",
    };
    const bundles = [baseBundle, deletedBundle, nextBundle];
    const getBundles = vi.fn(async (options) => ({
      data: bundles.slice(0, options.limit),
      pagination: {
        total: bundles.length,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 1,
      },
    }));

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundles.find((bundle) => bundle.id === bundleId) ?? null,
          list: async (_context, input) => getBundles(input),
          getChannels: async () => ["production"],
          commit: async () => undefined,
        }),
    })({})();

    await deleteBundleById(plugin, undefined, {
      id: deletedBundle.id,
      bundle: deletedBundle,
    });

    await expect(
      plugin.bundles.list(undefined, {
        limit: 2,
        orderBy: { field: "id", direction: "asc" },
      }),
    ).resolves.toMatchObject({
      data: [baseBundle, nextBundle],
      pagination: {
        total: 2,
        totalPages: 1,
      },
    });
    expect(getBundles).toHaveBeenLastCalledWith({
      limit: 3,
      offset: 0,
      orderBy: { field: "id", direction: "asc" },
      where: undefined,
    });
  });

  it("keeps pending inserts visible by id but out of provider-paginated lists", async () => {
    const insertBundle = {
      ...baseBundle,
      id: "0195a408-8f13-7d9b-8df4-123456789abe",
      message: "Inserted",
    };

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundleId === baseBundle.id ? baseBundle : null,
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          commit: async () => undefined,
        }),
    })({})();

    await plugin.bundles.append(undefined, { data: insertBundle });

    await expect(
      plugin.bundles.get(undefined, { id: insertBundle.id }),
    ).resolves.toEqual(insertBundle);
    await expect(
      plugin.bundles.list(undefined, { limit: 10 }),
    ).resolves.toMatchObject({
      data: [baseBundle],
    });
  });

  it("clears pending unit-of-work state after a successful commit", async () => {
    const persistedBundle = { ...baseBundle, enabled: false };
    const getBundleById = vi
      .fn()
      .mockResolvedValueOnce(baseBundle)
      .mockResolvedValueOnce(persistedBundle);
    const commit = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id }) => getBundleById(id),
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          commit,
        }),
    })({})();

    await plugin.bundles.update(undefined, {
      id: baseBundle.id,
      data: { enabled: false },
    });
    await plugin.commit(undefined, {});

    await expect(
      plugin.bundles.get(undefined, { id: baseBundle.id }),
    ).resolves.toEqual(persistedBundle);
    expect(getBundleById).toHaveBeenCalledTimes(2);
  });

  it("clears request-scoped unit-of-work state after a successful commit", async () => {
    const context: RequestEnvContext<{ assetHost: string }> = {
      env: {
        assetHost: "https://assets.example.com",
      },
      request: new Request("https://updates.example.com"),
    };
    const stagedBundle = { ...baseBundle, enabled: false };
    const persistedBundle = {
      ...stagedBundle,
      message: "Persisted provider state",
    };
    const pagination = {
      total: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 1,
    };
    const getBundleById = vi
      .fn()
      .mockResolvedValueOnce(baseBundle)
      .mockResolvedValueOnce(persistedBundle);
    const getBundles = vi
      .fn()
      .mockResolvedValueOnce({ data: [baseBundle], pagination })
      .mockResolvedValueOnce({ data: [persistedBundle], pagination });
    const commit = vi.fn(async () => undefined);

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id }) => getBundleById(id),
          list: async (_context, input) => getBundles(input),
          getChannels: async () => [baseBundle.channel],
          commit,
        }),
    })({})();

    await plugin.bundles.update(context, {
      id: baseBundle.id,
      data: { enabled: false },
    });

    await expect(
      plugin.bundles.get(context, { id: baseBundle.id }),
    ).resolves.toEqual(stagedBundle);
    await expect(
      plugin.bundles.list(context, { limit: 10 }),
    ).resolves.toMatchObject({
      data: [stagedBundle],
    });

    await plugin.commit(context, {});

    await expect(
      plugin.bundles.get(context, { id: baseBundle.id }),
    ).resolves.toEqual(persistedBundle);
    await expect(
      plugin.bundles.list(context, { limit: 10 }),
    ).resolves.toMatchObject({
      data: [persistedBundle],
    });
    expect(getBundleById).toHaveBeenCalledTimes(2);
    expect(getBundles).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith(context, {
      changes: {
        analyticsEvents: [],
        bundlePatches: [],
        bundles: [{ operation: "update", data: stagedBundle }],
        ingestKeys: [],
      },
    });
  });

  it("keeps unit-of-work state isolated between request contexts", async () => {
    const contextA: RequestEnvContext<{ assetHost: string }> = {
      env: {
        assetHost: "https://assets-a.example.com",
      },
      request: new Request("https://updates-a.example.com"),
    };
    const contextB: RequestEnvContext<{ assetHost: string }> = {
      env: {
        assetHost: "https://assets-b.example.com",
      },
      request: new Request("https://updates-b.example.com"),
    };
    const getBundleById = vi.fn(async (bundleId: string) =>
      bundleId === baseBundle.id ? baseBundle : null,
    );

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id }) => getBundleById(id),
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          commit: async () => undefined,
        }),
    })({})();

    await plugin.bundles.update(contextA, {
      id: baseBundle.id,
      data: { enabled: false },
    });

    await expect(
      plugin.bundles.get(contextA, { id: baseBundle.id }),
    ).resolves.toEqual({
      ...baseBundle,
      enabled: false,
    });
    await expect(
      plugin.bundles.get(contextB, { id: baseBundle.id }),
    ).resolves.toEqual(baseBundle);
    expect(getBundleById).toHaveBeenCalledTimes(2);
  });

  it("forwards updates.check fast-path calls with context when provided", async () => {
    const expected = {
      fileHash: baseBundle.fileHash,
      id: baseBundle.id,
      message: baseBundle.message,
      shouldForceUpdate: baseBundle.shouldForceUpdate,
      status: "UPDATE" as const,
      storageUri: baseBundle.storageUri,
    };
    const getUpdateInfo = vi.fn(async () => expected);
    const args: GetBundlesArgs = {
      _updateStrategy: "appVersion",
      appVersion: "1.0.0",
      bundleId: baseBundle.id,
      platform: "ios",
    };
    const context: RequestEnvContext<{ assetHost: string }> = {
      env: {
        assetHost: "https://assets.example.com",
      },
      request: new Request("https://updates.example.com"),
    };

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundleId === baseBundle.id ? baseBundle : null,
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          updates: { check: getUpdateInfo },
          commit: async () => undefined,
        }),
    })({})();

    await expect(plugin.updates?.check(context, args)).resolves.toEqual(
      expected,
    );
    expect(getUpdateInfo).toHaveBeenCalledWith(context, args);
  });

  it("exposes update checks as the isolated updates.check fast path", async () => {
    const expected = {
      id: baseBundle.id,
      message: null,
      shouldForceUpdate: false,
      status: "UPDATE" as const,
      storageUri: baseBundle.storageUri,
      fileHash: baseBundle.fileHash,
    };
    const getUpdateInfo = vi.fn(async () => expected);
    const args: GetBundlesArgs = {
      _updateStrategy: "appVersion",
      appVersion: "1.0.0",
      bundleId: baseBundle.id,
      platform: "ios",
    };
    const context: RequestEnvContext<{ assetHost: string }> = {
      env: {
        assetHost: "https://assets.example.com",
      },
      request: new Request("https://updates.example.com"),
    };

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundleId === baseBundle.id ? baseBundle : null,
          list: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          getChannels: async () => ["production"],
          updates: { check: getUpdateInfo },
          commit: async () => undefined,
        }),
    })({})();

    await expect(plugin.updates?.check(context, args)).resolves.toEqual(
      expected,
    );
    expect(getUpdateInfo).toHaveBeenCalledWith(context, args);
  });

  it("rejects removed offset pagination on the public plugin API", async () => {
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          get: async () => null,
          list: async () => ({
            data: [],
            pagination: {
              total: 0,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 0,
            },
          }),
          getChannels: async () => [],
          commit: async () => undefined,
        }),
    })({})();

    await expect(
      plugin.bundles.list(undefined, { limit: 20, offset: 10 } as never),
    ).rejects.toThrow(
      "Bundle offset pagination has been removed. Use cursor.after or cursor.before instead.",
    );
  });

  it("adapts cursor pagination for legacy database methods that still page by offset", async () => {
    const bundles = [
      { ...baseBundle, id: "bundle-300" },
      { ...baseBundle, id: "bundle-200" },
      { ...baseBundle, id: "bundle-100" },
    ];

    const plugin = createDatabasePlugin({
      name: "legacy-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundles.find((bundle) => bundle.id === bundleId) ?? null,
          list: async (_context, options) => {
            const offset = options.offset ?? 0;
            const filtered = bundles
              .filter((bundle) => {
                if (options.where?.id?.lt) {
                  return bundle.id.localeCompare(options.where.id.lt) < 0;
                }
                if (options.where?.id?.gt) {
                  return bundle.id.localeCompare(options.where.id.gt) > 0;
                }
                return true;
              })
              .sort((a, b) => {
                const result = a.id.localeCompare(b.id);
                return options.orderBy?.direction === "asc" ? result : -result;
              });
            const page =
              options.limit > 0
                ? filtered.slice(offset, offset + options.limit)
                : filtered.slice(offset);

            return {
              data: page,
              pagination: {
                total: filtered.length,
                hasNextPage: offset + options.limit < filtered.length,
                hasPreviousPage: offset > 0,
                currentPage: Math.floor(offset / options.limit) + 1,
                totalPages: Math.ceil(filtered.length / options.limit),
              },
            };
          },
          getChannels: async () => ["production"],
          commit: async () => undefined,
        }),
    })({})();

    const firstPage = await plugin.bundles.list(undefined, { limit: 2 });
    const secondPage = await plugin.bundles.list(undefined, {
      limit: 2,
      cursor: {
        after: firstPage.pagination.nextCursor ?? undefined,
      },
    });

    expect(firstPage.data.map((bundle) => bundle.id)).toEqual([
      "bundle-300",
      "bundle-200",
    ]);
    expect(firstPage.pagination.nextCursor).toBe("bundle-200");
    expect(secondPage.data.map((bundle) => bundle.id)).toEqual(["bundle-100"]);
    expect(secondPage.pagination.previousCursor).toBe("bundle-100");
    expect(secondPage.pagination.currentPage).toBe(2);
  });

  it("uses internal offset pagination when a stable page number is provided", async () => {
    const bundles = Array.from({ length: 45 }, (_, index) => ({
      ...baseBundle,
      id: `bundle-${String(45 - index).padStart(3, "0")}`,
    }));
    const getBundles = vi.fn(async (options) => {
      const filtered = bundles.slice();
      const offset = options.offset ?? 0;
      const page =
        options.limit > 0
          ? filtered.slice(offset, offset + options.limit)
          : filtered.slice(offset);

      return {
        data: page,
        pagination: {
          total: filtered.length,
          hasNextPage: offset + options.limit < filtered.length,
          hasPreviousPage: offset > 0,
          currentPage: Math.floor(offset / options.limit) + 1,
          totalPages: Math.ceil(filtered.length / options.limit),
        },
      };
    });

    const plugin = createDatabasePlugin({
      name: "page-aware-plugin",
      factory: () =>
        nested({
          get: async (_context, { id: bundleId }) =>
            bundles.find((bundle) => bundle.id === bundleId) ?? null,
          list: async (_context, input) => getBundles(input),
          getChannels: async () => ["production"],
          commit: async () => undefined,
        }),
    })({})();

    const pageTwo = await plugin.bundles.list(undefined, {
      limit: 20,
      page: 2,
      cursor: {
        after: "bundle-033",
      },
    });

    expect(getBundles).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 20,
        offset: 20,
        cursor: {
          after: "bundle-033",
        },
      }),
    );
    expect(pageTwo.data.map((bundle) => bundle.id)).toEqual([
      "bundle-025",
      "bundle-024",
      "bundle-023",
      "bundle-022",
      "bundle-021",
      "bundle-020",
      "bundle-019",
      "bundle-018",
      "bundle-017",
      "bundle-016",
      "bundle-015",
      "bundle-014",
      "bundle-013",
      "bundle-012",
      "bundle-011",
      "bundle-010",
      "bundle-009",
      "bundle-008",
      "bundle-007",
      "bundle-006",
    ]);
    expect(pageTwo.pagination.currentPage).toBe(2);
    expect(pageTwo.pagination.previousCursor).toBe("bundle-025");
    expect(pageTwo.pagination.nextCursor).toBe("bundle-006");
  });
});
