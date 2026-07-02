import { describe, expect, it, vi } from "vitest";

import {
  type AbstractDatabasePlugin,
  createDatabasePlugin,
} from "./createDatabasePlugin";
import type {
  Bundle,
  DatabaseAnalyticsOperations,
  DatabasePlugin,
  GetBundlesArgs,
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
type ExpectedAnalyticsOperationKeys =
  | "getLifecycleMetrics"
  | "getTelemetryKeyCredential"
  | "insertLifecycleEvent"
  | "upsertTelemetryKeyCredential";

type _AnalyticsOperationsMatchDatabasePlugin = Expect<
  Equal<
    NonNullable<DatabasePlugin["analytics"]>,
    DatabaseAnalyticsOperations<unknown>
  >
>;
type _AnalyticsOperationsExposeOnlyStorageKeys = Expect<
  Equal<AnalyticsOperationKeys, ExpectedAnalyticsOperationKeys>
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
  getChannels: AbstractDatabasePlugin["channels"]["getChannels"];
  onUnmount?: AbstractDatabasePlugin["onUnmount"];
};

const nested = ({
  getChannels,
  onUnmount,
  ...bundles
}: TestFactoryMethods): AbstractDatabasePlugin => ({
  bundles,
  channels: { getChannels },
  ...(onUnmount ? { onUnmount } : {}),
});

describe("createDatabasePlugin", () => {
  it("groups database methods by concern", async () => {
    const commitBundle = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () => ({
        bundles: {
          getBundleById: async (bundleId) =>
            bundleId === baseBundle.id ? baseBundle : null,
          getBundles: async () => ({
            data: [baseBundle],
            pagination: {
              total: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
            },
          }),
          commitBundle,
        },
        channels: {
          getChannels: async () => ["production"],
        },
      }),
    })({})();

    await plugin.bundles.updateBundle(baseBundle.id, { enabled: false });
    await expect(plugin.channels.getChannels()).resolves.toEqual([
      "production",
    ]);
    await plugin.bundles.commitBundle();

    expect(commitBundle).toHaveBeenCalledWith({
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
          },
        },
      ],
    });
  });

  it("replaces targetCohorts instead of merging array items", async () => {
    const commitBundle = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          getBundleById: async (bundleId) =>
            bundleId === baseBundle.id ? baseBundle : null,
          getBundles: async () => ({
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
          commitBundle,
        }),
    })({})();

    await plugin.bundles.updateBundle(baseBundle.id, {
      targetCohorts: ["device-2"],
    });
    await plugin.bundles.commitBundle();

    expect(commitBundle).toHaveBeenCalledWith({
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            targetCohorts: ["device-2"],
          },
        },
      ],
    });
  });

  it("preserves pending updates while allowing targetCohorts to be cleared", async () => {
    const commitBundle = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          getBundleById: async (bundleId) =>
            bundleId === baseBundle.id ? baseBundle : null,
          getBundles: async () => ({
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
          commitBundle,
        }),
    })({})();

    await plugin.bundles.updateBundle(baseBundle.id, { enabled: false });
    await plugin.bundles.updateBundle(baseBundle.id, { targetCohorts: null });
    await plugin.bundles.commitBundle();

    expect(commitBundle).toHaveBeenCalledWith({
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
            targetCohorts: null,
          },
        },
      ],
    });
  });

  it("preserves pending changes after a failed commit", async () => {
    const getBundleById = vi.fn(async (bundleId: string) =>
      bundleId === baseBundle.id ? baseBundle : null,
    );
    const commitBundle = vi
      .fn()
      .mockRejectedValueOnce(new Error("commit failed"))
      .mockResolvedValueOnce(undefined);

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          getBundleById,
          getBundles: async () => ({
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
          commitBundle,
        }),
    })({})();

    await plugin.bundles.updateBundle(baseBundle.id, {
      enabled: false,
    });
    await expect(plugin.bundles.commitBundle()).rejects.toThrow(
      "commit failed",
    );
    await plugin.bundles.commitBundle();

    expect(getBundleById).toHaveBeenCalledTimes(1);
    expect(commitBundle).toHaveBeenNthCalledWith(1, {
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
          },
        },
      ],
    });
    expect(commitBundle).toHaveBeenNthCalledWith(2, {
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
          },
        },
      ],
    });
  });

  it("stages no-context updates without keeping read-only cache entries", async () => {
    const getBundleById = vi.fn(async (bundleId: string) =>
      bundleId === baseBundle.id ? baseBundle : null,
    );
    const commitBundle = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          getBundleById,
          getBundles: async () => ({
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
          commitBundle,
        }),
    })({})();

    await expect(
      plugin.bundles.getBundleById(baseBundle.id),
    ).resolves.toStrictEqual(baseBundle);
    await plugin.bundles.updateBundle(baseBundle.id, {
      enabled: false,
    });
    await plugin.bundles.commitBundle();

    expect(getBundleById).toHaveBeenCalledTimes(2);
    expect(commitBundle).toHaveBeenCalledWith({
      changedSets: [
        {
          operation: "update",
          data: {
            ...baseBundle,
            enabled: false,
          },
        },
      ],
    });
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
          getBundleById,
          getBundles: async () => ({
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
          commitBundle: async () => undefined,
        }),
    })({})();

    await expect(
      plugin.bundles.getBundleById(baseBundle.id, context),
    ).resolves.toEqual(baseBundle);
    await plugin.bundles.updateBundle(
      baseBundle.id,
      { enabled: false },
      context,
    );

    await expect(
      plugin.bundles.getBundleById(baseBundle.id, context),
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
          getBundleById,
          getBundles: async () => ({
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
          commitBundle: async () => undefined,
        }),
    })({})();

    await expect(plugin.bundles.getBundleById(baseBundle.id)).resolves.toEqual(
      baseBundle,
    );
    await expect(plugin.bundles.getBundleById(baseBundle.id)).resolves.toEqual(
      nextBundle,
    );
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
          getBundleById,
          getBundles: async () => ({
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
          commitBundle: async () => undefined,
        }),
    })({})();

    await plugin.bundles.updateBundle(baseBundle.id, { enabled: false });
    await plugin.bundles.deleteBundle(deleteBundle);

    await expect(
      plugin.bundles.getBundles({
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
          getBundleById: async (bundleId) =>
            bundleId === baseBundle.id ? baseBundle : null,
          getBundles: async () => ({
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
          commitBundle: async () => undefined,
        }),
    })({})();

    await plugin.bundles.updateBundle(
      baseBundle.id,
      { enabled: false },
      context,
    );

    await expect(
      plugin.bundles.getBundles(
        {
          limit: 10,
          where: { enabled: true },
        },
        context,
      ),
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
          getBundleById: async (bundleId) =>
            bundleId === disabledBundle.id ? disabledBundle : null,
          getBundles: async () => ({
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
          commitBundle: async () => undefined,
        }),
    })({})();

    await plugin.bundles.updateBundle(
      disabledBundle.id,
      { enabled: true },
      context,
    );

    await expect(
      plugin.bundles.getBundles(
        {
          limit: 10,
          where: { enabled: true },
        },
        context,
      ),
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
          getBundleById: async (bundleId) =>
            bundles.find((bundle) => bundle.id === bundleId) ?? null,
          getBundles,
          getChannels: async () => ["production"],
          commitBundle: async () => undefined,
        }),
    })({})();

    await plugin.bundles.deleteBundle(deletedBundle);

    await expect(
      plugin.bundles.getBundles({
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
          getBundleById: async (bundleId) =>
            bundleId === baseBundle.id ? baseBundle : null,
          getBundles: async () => ({
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
          commitBundle: async () => undefined,
        }),
    })({})();

    await plugin.bundles.appendBundle(insertBundle);

    await expect(
      plugin.bundles.getBundleById(insertBundle.id),
    ).resolves.toEqual(insertBundle);
    await expect(
      plugin.bundles.getBundles({ limit: 10 }),
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
    const commitBundle = vi.fn();

    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          getBundleById,
          getBundles: async () => ({
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
          commitBundle,
        }),
    })({})();

    await plugin.bundles.updateBundle(baseBundle.id, { enabled: false });
    await plugin.bundles.commitBundle();

    await expect(plugin.bundles.getBundleById(baseBundle.id)).resolves.toEqual(
      persistedBundle,
    );
    expect(getBundleById).toHaveBeenCalledTimes(2);
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
          getBundleById,
          getBundles: async () => ({
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
          commitBundle: async () => undefined,
        }),
    })({})();

    await plugin.bundles.updateBundle(
      baseBundle.id,
      { enabled: false },
      contextA,
    );

    await expect(
      plugin.bundles.getBundleById(baseBundle.id, contextA),
    ).resolves.toEqual({
      ...baseBundle,
      enabled: false,
    });
    await expect(
      plugin.bundles.getBundleById(baseBundle.id, contextB),
    ).resolves.toEqual(baseBundle);
    expect(getBundleById).toHaveBeenCalledTimes(2);
  });

  it("forwards getUpdateInfo fast-path calls with context when provided", async () => {
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
          getBundleById: async (bundleId) =>
            bundleId === baseBundle.id ? baseBundle : null,
          getBundles: async () => ({
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
          getUpdateInfo,
          commitBundle: async () => undefined,
        }),
    })({})();

    await expect(
      plugin.bundles.getUpdateInfo?.(args, context),
    ).resolves.toEqual(expected);
    expect(getUpdateInfo).toHaveBeenCalledWith(args, context);
  });

  it("rejects removed offset pagination on the public plugin API", async () => {
    const plugin = createDatabasePlugin({
      name: "test-plugin",
      factory: () =>
        nested({
          getBundleById: async () => null,
          getBundles: async () => ({
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
          commitBundle: async () => undefined,
        }),
    })({})();

    await expect(
      plugin.bundles.getBundles({ limit: 20, offset: 10 } as never),
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
          getBundleById: async (bundleId) =>
            bundles.find((bundle) => bundle.id === bundleId) ?? null,
          getBundles: async (options) => {
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
          commitBundle: async () => undefined,
        }),
    })({})();

    const firstPage = await plugin.bundles.getBundles({ limit: 2 });
    const secondPage = await plugin.bundles.getBundles({
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
          supportsCursorPagination: true,
          getBundleById: async (bundleId) =>
            bundles.find((bundle) => bundle.id === bundleId) ?? null,
          getBundles,
          getChannels: async () => ["production"],
          commitBundle: async () => undefined,
        }),
    })({})();

    const pageTwo = await plugin.bundles.getBundles({
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
