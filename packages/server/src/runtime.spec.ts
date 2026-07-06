import { readFile } from "fs/promises";

import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import type {
  BundleListQuery,
  BundlePatchListQuery,
  CursorPage,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
  DatabasePluginCore,
  DatabasePluginRuntime,
  RequestEnvContext,
  RuntimeStoragePlugin,
  RuntimeStorageProfile,
  UpdateInfoRepository,
} from "@hot-updater/plugin-core";
import {
  createDatabasePlugin,
  markDatabaseRuntimeOpener,
  toDatabaseBundlePatches,
  toDatabaseBundleRecord,
} from "@hot-updater/plugin-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { DatabaseAdapterCapabilities, Migrator } from "./db/types";
import { createHotUpdater } from "./index";
import type { HandlerAPI, HandlerOptions, HandlerRoutes } from "./index";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

const bundle: Bundle = {
  id: "00000000-0000-0000-0000-000000000001",
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "hash123",
  gitCommitHash: null,
  message: "Test bundle",
  channel: "production",
  storageUri: "s3://test-bucket/bundles/bundle.zip",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
};

type TestEnv = {
  assetHost: string;
};

type TestContext = RequestEnvContext<TestEnv>;

const createRuntimeStorage = (
  getDownloadUrl: RuntimeStorageProfile<TestContext>["getDownloadUrl"],
  readText: RuntimeStorageProfile<TestContext>["readText"] = async () => null,
): RuntimeStoragePlugin<TestContext> => ({
  name: "testStorage",
  supportedProtocol: "s3",
  profiles: {
    runtime: {
      getDownloadUrl,
      readText,
    },
  },
});

const createPage = <TData>(data: readonly TData[]): CursorPage<TData> => ({
  data,
  pagination: {
    currentPage: 1,
    hasNextPage: false,
    hasPreviousPage: false,
    nextCursor: null,
    previousCursor: null,
    total: data.length,
    totalPages: data.length === 0 ? 0 : 1,
  },
});

const matchesBundleQuery = (
  bundle: DatabaseBundleRecord,
  query: BundleListQuery,
): boolean => {
  const where = query.where;
  if (!where) return true;
  if (where.channel !== undefined && bundle.channel !== where.channel) {
    return false;
  }
  if (where.platform !== undefined && bundle.platform !== where.platform) {
    return false;
  }
  if (where.enabled !== undefined && bundle.enabled !== where.enabled) {
    return false;
  }
  if (
    where.targetAppVersion !== undefined &&
    bundle.targetAppVersion !== where.targetAppVersion
  ) {
    return false;
  }
  if (
    where.targetAppVersionNotNull === true &&
    bundle.targetAppVersion === null
  ) {
    return false;
  }
  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  ) {
    return false;
  }
  const id = where.id;
  if (!id) return true;
  if (id.eq !== undefined && bundle.id !== id.eq) return false;
  if (id.gt !== undefined && bundle.id.localeCompare(id.gt) <= 0) {
    return false;
  }
  if (id.gte !== undefined && bundle.id.localeCompare(id.gte) < 0) {
    return false;
  }
  if (id.lt !== undefined && bundle.id.localeCompare(id.lt) >= 0) {
    return false;
  }
  if (id.lte !== undefined && bundle.id.localeCompare(id.lte) > 0) {
    return false;
  }
  return !(id.in !== undefined && !id.in.includes(bundle.id));
};

const matchesPatchQuery = (
  patch: DatabaseBundlePatch,
  query: BundlePatchListQuery,
): boolean => {
  const where = query.where;
  if (!where) return true;
  if (where.bundleId !== undefined && patch.bundleId !== where.bundleId) {
    return false;
  }
  if (
    where.baseBundleId !== undefined &&
    patch.baseBundleId !== where.baseBundleId
  ) {
    return false;
  }
  if (
    where.bundleIdIn !== undefined &&
    !where.bundleIdIn.includes(patch.bundleId)
  ) {
    return false;
  }
  return !(
    where.baseBundleIdIn !== undefined &&
    !where.baseBundleIdIn.includes(patch.baseBundleId)
  );
};

const seedBundle = (
  bundles: Map<string, DatabaseBundleRecord>,
  patches: Map<string, DatabaseBundlePatch>,
  nextBundle: Bundle,
) => {
  bundles.set(nextBundle.id, toDatabaseBundleRecord(nextBundle));
  for (const patch of toDatabaseBundlePatches(nextBundle)) {
    patches.set(patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`, patch);
  }
};

type CreateTestDatabaseOptions = {
  readonly bundles?: readonly Bundle[];
  readonly name?: string;
  readonly onBeforeInsert?: DatabasePluginCore["bundles"]["insert"];
  readonly updateInfo?: UpdateInfoRepository["get"];
};

const createTestDatabase = (
  options: CreateTestDatabaseOptions = {},
): {
  readonly bundles: Map<string, DatabaseBundleRecord>;
  readonly database: DatabasePluginRuntime;
  readonly patches: Map<string, DatabaseBundlePatch>;
} => {
  const bundles = new Map<string, DatabaseBundleRecord>();
  const patches = new Map<string, DatabaseBundlePatch>();
  for (const nextBundle of options.bundles ?? []) {
    seedBundle(bundles, patches, nextBundle);
  }

  const database = createDatabasePlugin({
    name: options.name ?? "testDatabase",
    connect: (): DatabasePluginCore => ({
      bundles: {
        getById: async ({ bundleId }) => bundles.get(bundleId) ?? null,
        list: async (query) => {
          const direction = query.orderBy?.direction ?? "desc";
          const data = Array.from(bundles.values())
            .filter((nextBundle) => matchesBundleQuery(nextBundle, query))
            .sort((left, right) => {
              const result = left.id.localeCompare(right.id);
              return direction === "asc" ? result : -result;
            })
            .slice(0, query.limit);
          return createPage(data);
        },
        insert: async (params) => {
          await options.onBeforeInsert?.(params);
          const nextBundle = params.bundle;
          bundles.set(nextBundle.id, nextBundle);
        },
        update: async ({ bundleId, patch }) => {
          const current = bundles.get(bundleId);
          if (current) {
            bundles.set(bundleId, { ...current, ...patch });
          }
        },
        delete: async ({ bundleId }) => {
          bundles.delete(bundleId);
        },
      },
      bundlePatches: {
        list: async (query) => {
          const data = Array.from(patches.values())
            .filter((patch) => matchesPatchQuery(patch, query))
            .sort(
              (left, right) =>
                left.orderIndex - right.orderIndex ||
                left.baseBundleId.localeCompare(right.baseBundleId),
            )
            .slice(0, query.limit);
          return createPage(data);
        },
        replaceForBundle: async ({ bundleId, patches: nextPatches }) => {
          for (const [patchId, patch] of patches) {
            if (patch.bundleId === bundleId) {
              patches.delete(patchId);
            }
          }
          for (const patch of nextPatches) {
            patches.set(
              patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`,
              patch,
            );
          }
        },
        deleteForBundle: async ({ bundleId }) => {
          for (const [patchId, patch] of patches) {
            if (patch.bundleId === bundleId) {
              patches.delete(patchId);
            }
          }
        },
        deleteForBaseBundle: async ({ baseBundleId }) => {
          for (const [patchId, patch] of patches) {
            if (patch.baseBundleId === baseBundleId) {
              patches.delete(patchId);
            }
          }
        },
      },
      ...(options.updateInfo
        ? {
            updateInfo: {
              get: options.updateInfo,
            },
          }
        : {}),
    }),
  })({});

  return { bundles, database, patches };
};

const createSchemaManagedDatabase = (
  adapterName: string,
  version: string | undefined,
): DatabasePluginRuntime & DatabaseAdapterCapabilities => {
  const { database } = createTestDatabase({
    name: `${adapterName}Database`,
  });
  return Object.assign(database, {
    adapterName,
    createMigrator: () =>
      ({
        async getVersion() {
          return version;
        },
        async getNameVariants() {
          return {};
        },
        async next() {
          return undefined;
        },
        async previous() {
          return undefined;
        },
        async up() {
          throw new Error("not implemented");
        },
        async down() {
          throw new Error("not implemented");
        },
        async migrateTo() {
          throw new Error("not implemented");
        },
        async migrateToLatest() {
          throw new Error("not implemented");
        },
        async migrate() {},
      }) as Migrator,
  });
};

describe("runtime createHotUpdater", () => {
  it("publishes db tooling subpath and removes the runtime subpath", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf-8"),
    ) as {
      exports: Record<string, unknown>;
    };

    expect(packageJson.exports["./db"]).toBeDefined();
    expect(packageJson.exports["./runtime"]).toBeUndefined();
  });

  it("exports runtime-safe handler types from the root entry", () => {
    expectTypeOf<HandlerAPI>().toHaveProperty("getBundles");
    expectTypeOf<HandlerOptions>().toHaveProperty("routes");
    expectTypeOf<HandlerRoutes>().toEqualTypeOf<{
      updateCheck: boolean;
      bundles: boolean;
    }>();
  });

  it("exports the root runtime API without database capabilities", () => {
    const { database } = createTestDatabase();

    const hotUpdater = createHotUpdater({ database });

    expect(hotUpdater.basePath).toBe("/api");
    expect(hotUpdater.adapterName).toBe("testDatabase");
    expect(hotUpdater.handler).toEqual(expect.any(Function));
    expect("createMigrator" in hotUpdater).toBe(false);
    expect("generateSchema" in hotUpdater).toBe(false);
    expectTypeOf(hotUpdater).not.toHaveProperty("createMigrator");
    expectTypeOf(hotUpdater).not.toHaveProperty("generateSchema");
  });

  it("accepts promise-like database runtimes at the root entry", async () => {
    const { database } = createTestDatabase({ bundles: [bundle] });
    const thenableDatabase: PromiseLike<DatabasePluginRuntime> = {
      then: (resolve, reject) =>
        Promise.resolve(database).then(resolve, reject),
    };

    const hotUpdater = createHotUpdater({ database: thenableDatabase });

    await expect(hotUpdater.getBundleById(bundle.id)).resolves.toMatchObject({
      id: bundle.id,
    });
    expect(hotUpdater.adapterName).toBe("database");
  });

  it("requires storages to implement the runtime profile", () => {
    const { database } = createTestDatabase();
    const nodeOnlyStorage = {
      name: "nodeOnlyStorage",
      supportedProtocol: "s3",
      profiles: {
        node: {
          delete: vi.fn(),
          downloadFile: vi.fn(),
          exists: vi.fn(async () => false),
          upload: vi.fn(),
        },
      },
    };

    expect(() =>
      createHotUpdater({
        database,
        storages: [
          nodeOnlyStorage as unknown as RuntimeStoragePlugin<TestContext>,
        ],
      }),
    ).toThrow(
      'nodeOnlyStorage does not implement the runtime storage profile for protocol "s3".',
    );
  });

  it("rejects runtime access when a Kysely schema is not initialized", async () => {
    const hotUpdater = createHotUpdater({
      database: createSchemaManagedDatabase("kysely", undefined),
    });

    await expect(hotUpdater.getBundles({ limit: 10 })).rejects.toThrow(
      "Hot Updater database schema is not initialized for kysely.",
    );
  });

  it("rejects runtime access when a MongoDB schema is stale", async () => {
    const hotUpdater = createHotUpdater({
      database: createSchemaManagedDatabase("mongodb", "0.21.0"),
    });

    await expect(hotUpdater.getChannels()).rejects.toThrow(
      "Hot Updater database schema version 0.21.0 is not supported by mongodb.",
    );
  });

  it("resolves storage URLs with handler context when database fast-path is used", async () => {
    const request = new Request(
      "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
        `${NIL_UUID}/${NIL_UUID}`,
    );
    const getUpdateInfo = vi.fn<UpdateInfoRepository["get"]>(async () => ({
      fileHash: bundle.fileHash,
      id: bundle.id,
      message: bundle.message,
      shouldForceUpdate: bundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: bundle.storageUri,
    }));
    const getDownloadUrl = vi.fn<
      RuntimeStorageProfile<TestContext>["getDownloadUrl"]
    >(async (_storageUri, context) => {
      return {
        fileUrl: new URL("/bundle.zip", context?.env?.assetHost).toString(),
      };
    });

    const openRuntime = markDatabaseRuntimeOpener<TestContext>(
      vi.fn(
        () =>
          createTestDatabase({
            bundles: [bundle],
            updateInfo: getUpdateInfo,
          }).database,
      ),
    );
    const storage = createRuntimeStorage(getDownloadUrl);

    const hotUpdater = createHotUpdater({
      database: openRuntime,
      storages: [storage],
      basePath: "/api/check-update",
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

    const response = await hotUpdater.handler(request, {
      env: {
        assetHost: "https://assets.example.com",
      },
      request,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fileHash: "hash123",
      fileUrl: "https://assets.example.com/bundle.zip",
      id: "00000000-0000-0000-0000-000000000001",
      message: "Test bundle",
      shouldForceUpdate: false,
      status: "UPDATE",
    });
    expect(getUpdateInfo).toHaveBeenCalledWith({
      _updateStrategy: "appVersion",
      appVersion: "1.0.0",
      bundleId: NIL_UUID,
      channel: "production",
      cohort: undefined,
      minBundleId: NIL_UUID,
      platform: "ios",
    });
    expect(openRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          assetHost: "https://assets.example.com",
        },
        request: expect.any(Request),
      }),
    );
    expect(getDownloadUrl).toHaveBeenCalledWith(
      "s3://test-bucket/bundles/bundle.zip",
      expect.objectContaining({
        env: {
          assetHost: "https://assets.example.com",
        },
        request: expect.any(Request),
      }),
    );
  });

  it("passes the handler context to database and storage resolution", async () => {
    const request = new Request(
      "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
        `${NIL_UUID}/${NIL_UUID}`,
    );
    const getDownloadUrl = vi.fn<
      RuntimeStorageProfile<TestContext>["getDownloadUrl"]
    >(async (_storageUri, context) => {
      return {
        fileUrl: new URL("/bundle.zip", context?.env?.assetHost).toString(),
      };
    });

    const openRuntime = markDatabaseRuntimeOpener<TestContext>(
      vi.fn(() => createTestDatabase({ bundles: [bundle] }).database),
    );
    const storage = createRuntimeStorage(getDownloadUrl);

    const hotUpdater = createHotUpdater({
      database: openRuntime,
      storages: [storage],
      basePath: "/api/check-update",
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

    expectTypeOf(hotUpdater.handler)
      .parameter(1)
      .toEqualTypeOf<TestContext | undefined>();

    const response = await hotUpdater.handler(request, {
      env: {
        assetHost: "https://assets.example.com",
      },
      request,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fileHash: "hash123",
      fileUrl: "https://assets.example.com/bundle.zip",
      id: "00000000-0000-0000-0000-000000000001",
      message: "Test bundle",
      shouldForceUpdate: false,
      status: "UPDATE",
    });
    expect(openRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          assetHost: "https://assets.example.com",
        },
        request: expect.any(Request),
      }),
    );
    expect(getDownloadUrl).toHaveBeenCalledWith(
      "s3://test-bucket/bundles/bundle.zip",
      expect.objectContaining({
        env: {
          assetHost: "https://assets.example.com",
        },
        request: expect.any(Request),
      }),
    );
  });

  it("returns bsdiff patch metadata when the full asset fallback URL is unavailable", async () => {
    const currentManifestStorageUri =
      "s3://test-bucket/releases/00000000-0000-0000-0000-000000000001/manifest.json";
    const nextManifestStorageUri =
      "s3://test-bucket/releases/00000000-0000-0000-0000-000000000002/manifest.json";
    const currentBundle: Bundle = {
      ...bundle,
      id: "00000000-0000-0000-0000-000000000001",
      assetBaseStorageUri:
        "s3://test-bucket/releases/00000000-0000-0000-0000-000000000001/files",
      manifestFileHash: "sig:current-manifest",
      manifestStorageUri: currentManifestStorageUri,
      storageUri:
        "s3://test-bucket/releases/00000000-0000-0000-0000-000000000001/bundle.zip",
    };
    const nextBundle: Bundle = {
      ...bundle,
      id: "00000000-0000-0000-0000-000000000002",
      assetBaseStorageUri:
        "s3://test-bucket/releases/00000000-0000-0000-0000-000000000002/files",
      manifestFileHash: "sig:next-manifest",
      manifestStorageUri: nextManifestStorageUri,
      patches: [
        {
          baseBundleId: currentBundle.id,
          baseFileHash: "hash-old-bundle",
          patchFileHash: "hash-bsdiff",
          patchStorageUri:
            "s3://test-bucket/releases/00000000-0000-0000-0000-000000000002/patches/00000000-0000-0000-0000-000000000001/index.ios.bundle.bsdiff",
        },
      ],
      storageUri:
        "s3://test-bucket/releases/00000000-0000-0000-0000-000000000002/bundle.zip",
    };
    const request = new Request(
      "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
        `${NIL_UUID}/${currentBundle.id}`,
    );
    const getDownloadUrl = vi.fn<
      RuntimeStorageProfile<TestContext>["getDownloadUrl"]
    >(async (storageUri, context) => {
      if (storageUri.endsWith("/files/index.ios.bundle")) {
        throw new Error("full asset fallback is unavailable");
      }

      const storageUrl = new URL(storageUri);
      return {
        fileUrl: new URL(
          storageUrl.pathname,
          context?.env?.assetHost,
        ).toString(),
      };
    });
    const manifests = new Map([
      [
        currentManifestStorageUri,
        JSON.stringify({
          assets: {
            "assets/logo.png": {
              fileHash: "hash-logo",
            },
            "index.ios.bundle": {
              fileHash: "hash-old-bundle",
            },
          },
          bundleId: currentBundle.id,
        }),
      ],
      [
        nextManifestStorageUri,
        JSON.stringify({
          assets: {
            "assets/logo.png": {
              fileHash: "hash-logo",
            },
            "index.ios.bundle": {
              fileHash: "hash-new-bundle",
            },
          },
          bundleId: nextBundle.id,
        }),
      ],
    ]);
    const readText = vi.fn<RuntimeStorageProfile<TestContext>["readText"]>(
      async (storageUri) => manifests.get(storageUri) ?? null,
    );
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("manifest fetch should not be used", {
        status: 500,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { database } = createTestDatabase({
      bundles: [currentBundle, nextBundle],
    });
    const storage = createRuntimeStorage(getDownloadUrl, readText);

    try {
      const hotUpdater = createHotUpdater({
        database,
        storages: [storage],
        basePath: "/api/check-update",
        routes: {
          updateCheck: true,
          bundles: false,
        },
      });

      const response = await hotUpdater.handler(request, {
        env: {
          assetHost: "https://assets.example.com",
        },
        request,
      });

      await expect(response.json()).resolves.toEqual({
        changedAssets: {
          "index.ios.bundle": {
            file: {
              compression: "br",
              url: "https://assets.example.com/releases/00000000-0000-0000-0000-000000000002/files/index.ios.bundle.br",
            },
            fileHash: "hash-new-bundle",
            patch: {
              algorithm: "bsdiff",
              baseBundleId: "00000000-0000-0000-0000-000000000001",
              baseFileHash: "hash-old-bundle",
              patchFileHash: "hash-bsdiff",
              patchUrl:
                "https://assets.example.com/releases/00000000-0000-0000-0000-000000000002/patches/00000000-0000-0000-0000-000000000001/index.ios.bundle.bsdiff",
            },
          },
        },
        fileHash: "hash123",
        fileUrl:
          "https://assets.example.com/releases/00000000-0000-0000-0000-000000000002/bundle.zip",
        id: "00000000-0000-0000-0000-000000000002",
        manifestFileHash: "sig:next-manifest",
        manifestUrl:
          "https://assets.example.com/releases/00000000-0000-0000-0000-000000000002/manifest.json",
        message: "Test bundle",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
      expect(readText).toHaveBeenCalledWith(
        nextManifestStorageUri,
        expect.objectContaining({
          env: {
            assetHost: "https://assets.example.com",
          },
          request: expect.any(Request),
        }),
      );
      expect(readText).toHaveBeenCalledWith(
        currentManifestStorageUri,
        expect.objectContaining({
          env: {
            assetHost: "https://assets.example.com",
          },
          request: expect.any(Request),
        }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not inject the request into context unless explicitly provided", async () => {
    const openRuntime = markDatabaseRuntimeOpener<TestContext>(
      vi.fn(() => createTestDatabase({ bundles: [bundle] }).database),
    );
    const storage = createRuntimeStorage(async () => {
      return { fileUrl: "https://assets.example.com/bundle.zip" };
    });

    const hotUpdater = createHotUpdater({
      database: openRuntime,
      storages: [storage],
      basePath: "/api/check-update",
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

    const response = await hotUpdater.handler(
      new Request(
        "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
          `${NIL_UUID}/${NIL_UUID}`,
      ),
      {
        env: {
          assetHost: "https://assets.example.com",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(openRuntime).toHaveBeenCalledWith({
      env: {
        assetHost: "https://assets.example.com",
      },
    });
  });

  it("opens one runtime per contextless handler request", async () => {
    const openRuntime = markDatabaseRuntimeOpener<TestContext>(
      vi.fn(
        () =>
          createTestDatabase({
            updateInfo: async () => ({
              id: bundle.id,
              message: null,
              shouldForceUpdate: false,
              status: "UPDATE",
              storageUri: null,
              fileHash: bundle.fileHash,
            }),
          }).database,
      ),
    );
    const storage = createRuntimeStorage(async () => {
      return { fileUrl: "https://assets.example.com/bundle.zip" };
    });
    const hotUpdater = createHotUpdater({
      database: openRuntime,
      storages: [storage],
      basePath: "/api/check-update",
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });
    const createRequest = () =>
      new Request(
        "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
          `${NIL_UUID}/${NIL_UUID}`,
      );

    await expect(hotUpdater.handler(createRequest())).resolves.toMatchObject({
      status: 200,
    });
    await expect(hotUpdater.handler(createRequest())).resolves.toMatchObject({
      status: 200,
    });

    expect(openRuntime).toHaveBeenCalledTimes(2);
    expect(openRuntime).toHaveBeenNthCalledWith(1, {});
    expect(openRuntime).toHaveBeenNthCalledWith(2, {});
    expect(vi.mocked(openRuntime).mock.calls[0]?.[0]).not.toBe(
      vi.mocked(openRuntime).mock.calls[1]?.[0],
    );
  });

  it("supports stripped base-path requests and ignores extra framework args", async () => {
    const openRuntime = markDatabaseRuntimeOpener<TestContext>(
      vi.fn(() => createTestDatabase({ bundles: [bundle] }).database),
    );
    const storage = createRuntimeStorage(async () => {
      return { fileUrl: "https://assets.example.com/bundle.zip" };
    });

    const hotUpdater = createHotUpdater({
      database: openRuntime,
      storages: [storage],
      basePath: "/api/check-update",
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

    const mountStyleHandler = hotUpdater.handler as (
      request: Request,
      context?: unknown,
      executionCtx?: unknown,
    ) => Promise<Response>;
    const response = await mountStyleHandler(
      new Request(
        "https://updates.example.com/app-version/ios/1.0.0/production/" +
          `${NIL_UUID}/${NIL_UUID}`,
      ),
      { someBinding: "ignored" },
      { waitUntil: () => undefined },
    );

    expect(response.status).toBe(200);
    expect(openRuntime).toHaveBeenCalledWith({});
  });

  it("keeps the version route mounted when bundle routes are disabled", async () => {
    const { database } = createTestDatabase({
      name: "version-enabled-plugin",
    });

    const hotUpdater = createHotUpdater({
      database,
      basePath: "/api/check-update",
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

    const response = await hotUpdater.handler(
      new Request("https://updates.example.com/api/check-update/version"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: HOT_UPDATER_SERVER_VERSION,
    });
  });

  it("keeps the version route mounted when update-check routes are disabled", async () => {
    const { database } = createTestDatabase({
      name: "version-disabled-plugin",
    });

    const hotUpdater = createHotUpdater({
      database,
      basePath: "/api/check-update",
      routes: {
        updateCheck: false,
        bundles: false,
      },
    });

    const response = await hotUpdater.handler(
      new Request("https://updates.example.com/api/check-update/version"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: HOT_UPDATER_SERVER_VERSION,
    });
  });

  it("keeps optional maintenance capabilities lazy", () => {
    const openRuntime = markDatabaseRuntimeOpener<TestContext>(
      vi.fn(
        () =>
          createTestDatabase({
            name: "lazyRuntimePlugin",
          }).database,
      ),
    );

    createHotUpdater({
      database: openRuntime,
      basePath: "/api/check-update",
    });

    expect(openRuntime).not.toHaveBeenCalled();
  });

  it("clears pending plugin changes after a failed mutation commit", async () => {
    let insertAttempt = 0;
    const { database } = createTestDatabase({
      name: "failingPlugin",
      onBeforeInsert: async () => {
        insertAttempt += 1;
        if (insertAttempt === 1) {
          throw new Error("commit failed");
        }
      },
    });

    const hotUpdater = createHotUpdater({
      database,
      basePath: "/api/check-update",
      routes: {
        updateCheck: false,
        bundles: false,
      },
    });

    const failedBundle: Bundle = {
      ...bundle,
      id: "00000000-0000-0000-0000-000000000010",
      message: "failed bundle",
    };
    const succeedingBundle: Bundle = {
      ...bundle,
      id: "00000000-0000-0000-0000-000000000011",
      message: "succeeding bundle",
    };

    await expect(hotUpdater.insertBundle(failedBundle)).rejects.toThrow(
      "commit failed",
    );
    await hotUpdater.insertBundle(succeedingBundle);

    expect(await hotUpdater.getBundleById(failedBundle.id)).toBeNull();
    await expect(
      hotUpdater.getBundleById(succeedingBundle.id),
    ).resolves.toMatchObject(succeedingBundle);
  });

  it("isolates pending mutation state between overlapping writes", async () => {
    const committedBundleIds: string[][] = [];
    let releaseFirstCommit!: () => void;
    let notifyFirstCommitStarted!: () => void;
    const firstCommitStarted = new Promise<void>((resolve) => {
      notifyFirstCommitStarted = resolve;
    });
    const firstCommitGate = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    let insertCount = 0;

    const { database } = createTestDatabase({
      name: "isolatedPlugin",
      onBeforeInsert: async ({ bundle: nextBundle }) => {
        insertCount += 1;
        committedBundleIds.push([nextBundle.id]);

        if (insertCount === 1) {
          notifyFirstCommitStarted();
          await firstCommitGate;
        }
      },
    });

    const hotUpdater = createHotUpdater({
      database,
      basePath: "/api/check-update",
      routes: {
        updateCheck: false,
        bundles: false,
      },
    });

    const firstBundleId = "00000000-0000-0000-0000-000000000020";
    const secondBundleId = "00000000-0000-0000-0000-000000000021";

    const firstInsert = hotUpdater.insertBundle({
      ...bundle,
      id: firstBundleId,
      message: "first bundle",
    });
    await firstCommitStarted;

    const secondInsert = hotUpdater.insertBundle({
      ...bundle,
      id: secondBundleId,
      message: "second bundle",
    });

    releaseFirstCommit();
    await Promise.all([firstInsert, secondInsert]);

    expect(committedBundleIds).toEqual([[firstBundleId], [secondBundleId]]);
  });
});
