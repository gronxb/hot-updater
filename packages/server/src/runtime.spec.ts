import { NIL_UUID } from "@hot-updater/core";
// allow: SIZE_OK — this is the exhaustive server runtime integration matrix.
import {
  attachCapabilityContribution,
  createDatabaseClient,
  defineCapability,
  StorageConfigurationError,
  type HotUpdaterFeatureInvocation,
  type StorageInvocationToken,
  type StorageOperationContext,
  type StoragePluginV2,
  type DatabasePlugin,
  type RuntimeStoragePlugin,
  type RuntimeStorageProfile,
} from "@hot-updater/plugin-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import packageJson from "../package.json" with { type: "json" };
import { createHotUpdaterCore } from "./createHotUpdaterCore";
import { createHotUpdater } from "./index";
import type {
  CreateHotUpdaterOptions,
  HandlerAPI,
  HandlerOptions,
  HandlerRoutes,
  HotUpdaterPayloadTooLargeResponse,
  HotUpdaterRequestPolicy,
  RuntimeStorageInput,
  StorageContextResolverInput,
} from "./index";
import {
  defineFirstPartyFeatureManifest,
  type FeatureApiKind,
  requireHotUpdaterFeatureInvocation,
} from "./internal/first-party-plugin";
import {
  createRuntimeDatabase,
  createRuntimeStorage,
  createSchemaManagedDatabase,
  runtimeBundle,
  type TestContext,
} from "./runtime.testFixtures";
import { HOT_UPDATER_SCHEMA_VERSION } from "./schema/types";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

const updateUrl =
  "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
  `${NIL_UUID}/${NIL_UUID}`;

type StorageFeatureApi<TContext> = {
  readonly readFeature: (context?: TContext) => Promise<string | null>;
};

interface StorageFeatureKind extends FeatureApiKind {
  readonly availableApi: StorageFeatureApi<this["context"]>;
  readonly feature: StorageFeatureApi<this["context"]> & {
    readonly status: "available";
  };
}

type StorageReaderCapability = Readonly<{
  read(token: StorageInvocationToken): Promise<string | null>;
}>;

const storageReaderToken = defineCapability<StorageReaderCapability>({
  id: "test-storage-reader@1",
  parse(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof Reflect.get(value, "read") !== "function"
    ) {
      throw new TypeError("Invalid test storage reader.");
    }
    return Object.freeze({
      read(token) {
        return Reflect.apply(Reflect.get(value, "read"), value, [token]);
      },
    });
  },
});

const createStorageFeature = (
  observedContexts: unknown[] = [],
  observedTokens: StorageInvocationToken[] = [],
) =>
  defineFirstPartyFeatureManifest<
    "storageFeature",
    StorageFeatureKind,
    { readonly legacyReadFeature: "readFeature" }
  >({
    aliases: { legacyReadFeature: "readFeature" },
    featureApi: "required",
    id: "storage-feature",
    namespace: "storageFeature",
    requires: [{ missing: "error", token: storageReaderToken }],
    setup({ capabilities }) {
      const reader = capabilities.require(storageReaderToken);
      return {
        api: {
          invocation: {
            readFeature: { contextIndex: 0, publicArity: 1 },
          },
          legacyAliases: { legacyReadFeature: "readFeature" },
          namespace: "storageFeature",
          value: {
            async readFeature(
              _context,
              invocation?: HotUpdaterFeatureInvocation<unknown>,
            ) {
              observedContexts.push(_context);
              const active = requireHotUpdaterFeatureInvocation(invocation);
              observedTokens.push(active.storageToken);
              return reader.read(active.storageToken);
            },
            status: "available",
          },
        },
        routes: [
          {
            access: { kind: "public" },
            id: "storage-feature.route",
            method: "GET",
            path: "/storage-feature",
            async handle(context) {
              observedContexts.push(context.platformContext);
              const active = requireHotUpdaterFeatureInvocation(
                Reflect.get(context, "invocation"),
              );
              observedTokens.push(active.storageToken);
              return Response.json({
                text: await reader.read(active.storageToken),
              });
            },
          },
        ],
      };
    },
    version: "1.0.0",
  });

describe("runtime createHotUpdater", () => {
  it("publishes only the supported runtime and database subpaths", () => {
    // Given
    const packageExports = packageJson.exports;

    // When
    const databaseEntry = packageExports["./db"];
    const hasRuntimeEntry = Object.hasOwn(packageExports, "./runtime");

    // Then
    expect(databaseEntry).toBeDefined();
    expect(hasRuntimeEntry).toBe(false);
  });

  it("exports runtime-safe handler types from the root entry", () => {
    // Given / When / Then
    expectTypeOf<HandlerAPI>().toHaveProperty("getBundles");
    expectTypeOf<HandlerOptions>().toHaveProperty("routes");
    expectTypeOf<HandlerOptions["routes"]>().toEqualTypeOf<
      HandlerRoutes | undefined
    >();
    expectTypeOf<keyof HandlerOptions>().toEqualTypeOf<"basePath" | "routes">();
    expectTypeOf<keyof CreateHotUpdaterOptions>().toEqualTypeOf<
      | "basePath"
      | "database"
      | "plugins"
      | "routes"
      | "storageContext"
      | "storages"
    >();
    expectTypeOf<HotUpdaterRequestPolicy>().toEqualTypeOf<{
      readonly maximumBodyBytes: number;
      readonly payloadTooLargeResponse?: HotUpdaterPayloadTooLargeResponse;
    }>();
    expectTypeOf<
      CreateHotUpdaterOptions<TestContext>["storages"]
    >().toEqualTypeOf<
      readonly RuntimeStorageInput<TestContext>[] | undefined
    >();
  });

  it("accepts a direct v2 plugin object without exposing maintenance methods", () => {
    // Given
    const database: DatabasePlugin = {
      ...createInMemoryDatabasePlugin(),
      name: "contextlessTestDatabase",
    };
    const storage = (): RuntimeStoragePlugin<undefined> => ({
      name: "contextlessTestStorage",
      supportedProtocol: "s3",
      profiles: {
        runtime: {
          getDownloadUrl: async () => ({ fileUrl: "https://example.com" }),
          readText: async () => null,
        },
      },
    });

    // When
    const hotUpdater = createHotUpdater({ database, storages: [storage()] });

    // Then
    expect(hotUpdater.basePath).toBe("/api");
    expect(hotUpdater.adapterName).toBe("contextlessTestDatabase");
    expect(hotUpdater.handler).toEqual(expect.any(Function));
    expect("createMigrator" in hotUpdater).toBe(false);
    expect("generateSchema" in hotUpdater).toBe(false);
    expectTypeOf(hotUpdater).not.toHaveProperty("createMigrator");
    expectTypeOf(hotUpdater).not.toHaveProperty("generateSchema");
    expectTypeOf(hotUpdater.handler).parameter(1).toEqualTypeOf<undefined>();
  });

  it("materializes storage plugin factories exactly once", () => {
    // Given
    const database = createRuntimeDatabase();
    const storageFactory = vi.fn(() =>
      createRuntimeStorage(async () => ({ fileUrl: "https://example.com" })),
    );

    // When
    const hotUpdater = createHotUpdater({
      database,
      storages: [storageFactory],
    });

    // Then
    expect(storageFactory).toHaveBeenCalledOnce();
    expect(hotUpdater.adapterName).toBe(database.name);
  });

  it("rejects access when a managed schema is not initialized", async () => {
    // Given
    const hotUpdater = createHotUpdater({
      database: createSchemaManagedDatabase("kysely", undefined),
    });

    // When
    const result = hotUpdater.getBundles({ limit: 10 });

    // Then
    await expect(result).rejects.toThrow(
      "Hot Updater database schema is not initialized for kysely.",
    );
  });

  it("rejects access when a managed schema is stale", async () => {
    // Given
    const hotUpdater = createHotUpdater({
      database: createSchemaManagedDatabase("mongodb", "0.21.0"),
    });

    // When
    const result = hotUpdater.getChannels();

    // Then
    await expect(result).rejects.toThrow(
      "Hot Updater database schema version 0.21.0 is not supported by mongodb.",
    );
  });

  it("checks a ready managed schema only once", async () => {
    // Given
    const database = createSchemaManagedDatabase(
      "kysely",
      HOT_UPDATER_SCHEMA_VERSION,
    );
    const createMigrator = vi.spyOn(database, "createMigrator");
    const hotUpdater = createHotUpdater({ database });

    // When
    await hotUpdater.getChannels();
    await hotUpdater.getChannels();

    // Then
    expect(createMigrator).toHaveBeenCalledOnce();
  });

  it("passes handler context to storage but not the database plugin", async () => {
    // Given
    const request = new Request(updateUrl);
    const getUpdateInfo = vi.fn<NonNullable<DatabasePlugin["getUpdateInfo"]>>(
      async () => ({
        fileHash: runtimeBundle.fileHash,
        id: runtimeBundle.id,
        message: runtimeBundle.message,
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: runtimeBundle.storageUri,
      }),
    );
    const database: DatabasePlugin = {
      ...createRuntimeDatabase(),
      getUpdateInfo,
    };
    const getDownloadUrl = vi.fn<
      RuntimeStorageProfile<TestContext>["getDownloadUrl"]
    >(async (_storageUri, context) => ({
      fileUrl: new URL("/bundle.zip", context?.env?.assetHost).toString(),
    }));
    const hotUpdater = createHotUpdater({
      database,
      storages: [createRuntimeStorage(getDownloadUrl)],
      basePath: "/api/check-update",
      routes: { updateCheck: true, bundles: false },
    });
    expectTypeOf(hotUpdater.handler)
      .parameter(1)
      .toEqualTypeOf<TestContext | undefined>();
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
      request,
    };

    // When
    const response = await hotUpdater.handler(request, context);

    // Then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      fileUrl: "https://assets.example.com/bundle.zip",
      id: runtimeBundle.id,
      status: "UPDATE",
    });
    expect(getUpdateInfo).toHaveBeenCalledWith(expect.any(Object));
    expect(getDownloadUrl).toHaveBeenCalledWith(
      runtimeBundle.storageUri,
      context,
    );
  });

  it("does not pass handler context to generic database queries", async () => {
    // Given
    const request = new Request(updateUrl);
    const database = createRuntimeDatabase();
    await createDatabaseClient(database).insertBundle(runtimeBundle);
    const findMany = vi.spyOn(database, "findMany");
    const hotUpdater = createHotUpdater({
      database,
      storages: [
        createRuntimeStorage(async () => ({
          fileUrl: "https://assets.example.com/bundle.zip",
        })),
      ],
      basePath: "/api/check-update",
      routes: { updateCheck: true, bundles: false },
    });
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };

    // When
    const response = await hotUpdater.handler(request, context);

    // Then
    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.any(Object));
  });

  it("ignores framework bindings when an extra execution argument is passed", async () => {
    // Given
    const getUpdateInfo = vi.fn(async () => ({
      fileHash: runtimeBundle.fileHash,
      id: runtimeBundle.id,
      message: runtimeBundle.message,
      shouldForceUpdate: false,
      status: "UPDATE" as const,
      storageUri: runtimeBundle.storageUri,
    }));
    const database: DatabasePlugin = {
      ...createRuntimeDatabase(),
      getUpdateInfo,
    };
    const hotUpdater = createHotUpdater({
      database,
      storages: [
        createRuntimeStorage(async () => ({
          fileUrl: "https://assets.example.com/bundle.zip",
        })),
      ],
      basePath: "/api/check-update",
      routes: { updateCheck: true, bundles: false },
    });
    const request = new Request(updateUrl);

    // When
    const response = await Reflect.apply(hotUpdater.handler, undefined, [
      request,
      { binding: "ignored" },
      { waitUntil: () => undefined },
    ]);

    // Then
    expect(response.status).toBe(200);
    expect(getUpdateInfo).toHaveBeenCalledWith(expect.any(Object));
  });

  it.each([
    { updateCheck: true, bundles: false },
    { updateCheck: false, bundles: false },
  ])(
    "keeps the version route mounted for $updateCheck/$bundles",
    async (routes) => {
      // Given
      const hotUpdater = createHotUpdater({
        database: createRuntimeDatabase(),
        basePath: "/api/check-update",
        routes,
      });

      // When
      const response = await hotUpdater.handler(
        new Request("https://updates.example.com/api/check-update/version"),
      );

      // Then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        version: HOT_UPDATER_SERVER_VERSION,
        capabilities: {},
      });
    },
  );

  it("requires a resolver before accepting direct v2 storage", () => {
    // Given
    const storage = createRuntimeV2Storage();

    // When
    const construct = () =>
      createHotUpdater({
        database: createRuntimeDatabase(),
        storages: [storage],
      });

    // Then
    expect(construct).toThrowError(
      expect.objectContaining({
        code: "missing-storage-context",
        name: "StorageConfigurationError",
      }),
    );
  });

  it("resolves and forwards one fresh v2 context for a direct API call", async () => {
    // Given
    const get = vi.fn<StoragePluginV2["get"]>(async ({ storageUri }) => ({
      kind: "found",
      storageUri,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }),
      metadata: { contentLength: 2 },
    }));
    const issueDownload = vi.fn<NonNullable<StoragePluginV2["issueDownload"]>>(
      async ({ context: _context }) => ({
        kind: "issued",
        downloadUrl: "https://assets.example.com/bundle.zip",
      }),
    );
    const storage = createRuntimeV2Storage({ get, issueDownload });
    const resolverContext: StorageOperationContext = Object.freeze({
      target: "worker",
      environment: Object.freeze({ ASSET_HOST: "assets.example.com" }),
      bindings: Object.freeze({ bucket: { mutable: true } }),
    });
    const storageContext = vi.fn(() => resolverContext);
    const database: DatabasePlugin = {
      ...createRuntimeDatabase(),
      getUpdateInfo: async () => ({
        fileHash: runtimeBundle.fileHash,
        id: NIL_UUID,
        message: runtimeBundle.message,
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: runtimeBundle.storageUri,
      }),
    };
    const hotUpdater = createHotUpdater<TestContext>({
      database,
      storages: [storage],
      storageContext,
    });
    const platformContext: TestContext = {
      env: { assetHost: "https://platform.example.com" },
    };

    // When
    const result = await hotUpdater.getAppUpdateInfo(
      {
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        channel: "production",
        platform: "ios",
      },
      platformContext,
    );

    // Then
    expect(result?.fileUrl).toBe("https://assets.example.com/bundle.zip");
    expect(storageContext).toHaveBeenCalledOnce();
    expect(storageContext).toHaveBeenCalledWith({
      kind: "api",
      operation: { member: "getAppUpdateInfo", surface: "database" },
      context: platformContext,
    });
    expect(issueDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.not.objectContaining({ env: expect.anything() }),
      }),
    );
    expect(issueDownload.mock.calls[0]?.[0].context).not.toBe(resolverContext);
    expect(issueDownload.mock.calls[0]?.[0].context.bindings.bucket).toBe(
      resolverContext.bindings.bucket,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("closes only factory-owned storage once through core and API teardown", async () => {
    // Given
    const directUnmount = vi.fn(async () => undefined);
    const ownedUnmount = vi.fn(async () => undefined);
    const direct = createRuntimeStorage(async () => ({
      fileUrl: "https://example.com/direct",
    }));
    direct.onUnmount = directUnmount;
    const owned = createRuntimeStorage(async () => ({
      fileUrl: "https://example.com/owned",
    }));
    owned.supportedProtocol = "owned";
    owned.onUnmount = ownedUnmount;
    const core = createHotUpdaterCore({
      database: createRuntimeDatabase(),
      storages: [direct, () => owned],
    });

    // When
    const first = core.onUnmount();
    const second = core.api.onUnmount();
    await Promise.all([first, second]);

    // Then
    expect(first).toBe(second);
    expect(directUnmount).not.toHaveBeenCalled();
    expect(ownedUnmount).toHaveBeenCalledOnce();
  });

  it("uses the handler resolver boundary once for v2 delivery", async () => {
    // Given
    const issueDownload = vi.fn<NonNullable<StoragePluginV2["issueDownload"]>>(
      async ({ context }) => ({
        kind: "issued",
        downloadUrl: `https://${context.environment.ASSET_HOST}/bundle.zip`,
      }),
    );
    const request = new Request(updateUrl);
    const storageContext = vi.fn(() =>
      Object.freeze({
        target: "worker" as const,
        environment: Object.freeze({ ASSET_HOST: "handler.example.com" }),
        bindings: Object.freeze({}),
      }),
    );
    const database: DatabasePlugin = {
      ...createRuntimeDatabase(),
      getUpdateInfo: async () => ({
        fileHash: runtimeBundle.fileHash,
        id: NIL_UUID,
        message: runtimeBundle.message,
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: runtimeBundle.storageUri,
      }),
    };
    const hotUpdater = createHotUpdater<TestContext>({
      database,
      storages: [createRuntimeV2Storage({ issueDownload })],
      storageContext,
      basePath: "/api/check-update",
      routes: { bundles: false, updateCheck: true },
    });
    const context: TestContext = {
      env: { assetHost: "https://legacy.example.com" },
    };

    // When
    const response = await hotUpdater.handler(request, context);

    // Then
    expect(response.status).toBe(200);
    expect(storageContext).toHaveBeenCalledOnce();
    expect(storageContext).toHaveBeenCalledWith({
      kind: "handler",
      request,
      operation: { member: "getAppUpdateInfo", surface: "database" },
      context,
    });
    expect(issueDownload).toHaveBeenCalledOnce();
  });

  it("binds namespace, alias, and feature route storage to canonical invocations", async () => {
    // Given
    const observedContexts: unknown[] = [];
    const observedTokens: StorageInvocationToken[] = [];
    let retainedReader: StorageReaderCapability | undefined;
    const get = vi.fn<StoragePluginV2["get"]>(
      async ({ context, storageUri }) => ({
        kind: "found",
        storageUri,
        body: new Blob([String(context.bindings.requestId)]).stream(),
        metadata: {
          contentLength: String(context.bindings.requestId).length,
        },
      }),
    );
    const carrier = attachCapabilityContribution(
      createRuntimeV2Storage({ get }),
      {
        token: storageReaderToken,
        create(runtime) {
          const storage = runtime.storages.find(
            ({ supportedProtocol }) => supportedProtocol === "s3",
          );
          if (storage === undefined) {
            throw new TypeError("Missing guarded storage.");
          }
          retainedReader = Object.freeze({
            read(token: StorageInvocationToken) {
              return storage.readText("s3://bucket/feature", token);
            },
          });
          return retainedReader;
        },
      },
    );
    const resolverInputs: unknown[] = [];
    const storageContext = vi.fn(
      (input: StorageContextResolverInput<TestContext>) => {
        resolverInputs.push(input);
        return Object.freeze({
          target: "worker" as const,
          environment: Object.freeze({}),
          bindings: Object.freeze({
            requestId: input.context?.env?.assetHost ?? "none",
          }),
        });
      },
    );
    const feature = createStorageFeature(observedContexts, observedTokens);
    const hotUpdater = createHotUpdater<TestContext, readonly [typeof feature]>(
      {
        database: createRuntimeDatabase(),
        plugins: [feature],
        storages: [carrier],
        storageContext,
      },
    );
    const namespaceContext: TestContext = {
      env: { assetHost: "namespace" },
    };
    const middleContext: TestContext = { env: { assetHost: "middle" } };
    const routeContext: TestContext = { env: { assetHost: "route" } };

    // When
    const [namespace, middle, alias, response] = await Promise.all([
      hotUpdater.features.storageFeature.readFeature(namespaceContext),
      hotUpdater.features.storageFeature.readFeature(middleContext),
      hotUpdater.legacyReadFeature(namespaceContext),
      hotUpdater.handler(
        new Request("https://example.com/api/storage-feature"),
        routeContext,
      ),
    ]);

    // Then
    expect(namespace).toBe("namespace");
    expect(middle).toBe("middle");
    expect(alias).toBe("namespace");
    await expect(response.json()).resolves.toEqual({ text: "route" });
    expect(storageContext).toHaveBeenCalledTimes(4);
    expect(resolverInputs).toEqual([
      {
        kind: "api",
        operation: {
          member: "readFeature",
          namespace: "storageFeature",
          surface: "feature",
        },
        context: namespaceContext,
      },
      {
        kind: "api",
        operation: {
          member: "readFeature",
          namespace: "storageFeature",
          surface: "feature",
        },
        context: middleContext,
      },
      {
        kind: "api",
        operation: {
          invokedAlias: "legacyReadFeature",
          member: "readFeature",
          namespace: "storageFeature",
          surface: "feature",
        },
        context: namespaceContext,
      },
      {
        kind: "handler",
        request: expect.any(Request),
        operation: {
          member: "storage-feature.route",
          namespace: "storageFeature",
          surface: "feature",
        },
        context: routeContext,
      },
    ]);
    expect(observedContexts).toEqual([
      namespaceContext,
      middleContext,
      namespaceContext,
      routeContext,
    ]);
    expect(get).toHaveBeenCalledTimes(4);
    const retainedToken = observedTokens[0];
    if (retainedReader === undefined || retainedToken === undefined) {
      throw new TypeError("Expected retained feature capability and token.");
    }
    await expect(retainedReader.read(retainedToken)).rejects.toMatchObject({
      code: "invalid-storage-invocation",
    });
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("seals new calls and drains an active API call before owned cleanup", async () => {
    // Given
    let releaseFind: (() => void) | undefined;
    const database = createRuntimeDatabase();
    const findGate = new Promise<void>((resolve) => {
      releaseFind = resolve;
    });
    vi.spyOn(database, "findOne").mockImplementation(async () => {
      await findGate;
      return null;
    });
    const onUnmount = vi.fn(async () => undefined);
    const owned = createRuntimeStorage(async () => ({
      fileUrl: "https://example.com",
    }));
    owned.onUnmount = onUnmount;
    const core = createHotUpdaterCore({
      database,
      storages: [() => owned],
    });
    const active = core.api.getBundleById("bundle");

    // When
    const teardown = core.onUnmount();
    const rejected = core.api.getBundleById("new");

    // Then
    await expect(rejected).rejects.toMatchObject({ code: "disposed" });
    expect(onUnmount).not.toHaveBeenCalled();
    releaseFind?.();
    await active;
    await teardown;
    expect(onUnmount).toHaveBeenCalledOnce();
  });

  it("rolls back owned factories in reverse order after duplicate validation", () => {
    // Given
    const cleanupOrder: string[] = [];
    const borrowed = createRuntimeStorage(async () => ({
      fileUrl: "https://example.com",
    }));
    borrowed.supportedProtocol = "borrowed";
    borrowed.onUnmount = vi.fn(() => {
      cleanupOrder.push("borrowed");
    });
    const first = createRuntimeStorage(async () => ({
      fileUrl: "https://example.com",
    }));
    first.supportedProtocol = "duplicate";
    first.onUnmount = vi.fn(() => {
      cleanupOrder.push("first");
    });
    const second = createRuntimeStorage(async () => ({
      fileUrl: "https://example.com",
    }));
    second.supportedProtocol = "second";
    second.onUnmount = vi.fn(() => {
      cleanupOrder.push("second");
    });
    const duplicate = createRuntimeStorage(async () => ({
      fileUrl: "https://example.com",
    }));
    duplicate.supportedProtocol = "DUPLICATE";

    // When
    const construct = () =>
      createHotUpdater({
        database: createRuntimeDatabase(),
        storages: [borrowed, () => first, () => second, duplicate],
      });

    // Then
    expect(construct).toThrow(
      'Duplicate storage protocol "duplicate" from plugins',
    );
    expect(cleanupOrder).toEqual(["second", "first"]);
    expect(borrowed.onUnmount).not.toHaveBeenCalled();
  });

  it("rejects an async server factory synchronously and observes eventual cleanup", async () => {
    // Given
    const onUnmount = vi.fn(async () => undefined);
    const storage = createRuntimeStorage(async () => ({
      fileUrl: "https://example.com",
    }));
    storage.onUnmount = onUnmount;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    // When
    const construct = () =>
      Reflect.apply(createHotUpdater, undefined, [
        {
          database: createRuntimeDatabase(),
          storages: [async () => storage],
        },
      ]);

    // Then
    expect(construct).toThrowError(
      expect.objectContaining({ code: "async-server-factory" }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(onUnmount).toHaveBeenCalledOnce();
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });

  it("rejects a double thunk before route or storage access construction", () => {
    // Given
    const nested = vi.fn(() =>
      createRuntimeStorage(async () => ({
        fileUrl: "https://example.com",
      })),
    );

    // When
    const construct = () =>
      Reflect.apply(createHotUpdater, undefined, [
        {
          database: createRuntimeDatabase(),
          storages: [() => nested],
        },
      ]);

    // Then
    expect(construct).toThrowError(
      expect.objectContaining({ code: "invalid-storage-input" }),
    );
    expect(nested).not.toHaveBeenCalled();
  });
});

const createRuntimeV2Storage = (
  overrides: Partial<StoragePluginV2> = {},
): StoragePluginV2 => ({
  name: "runtime-v2",
  protocol: "s3",
  async put() {
    throw new StorageConfigurationError(
      "invalid-storage-input",
      "put is unused by this fixture",
    );
  },
  async head() {
    return { kind: "not-found" };
  },
  async get() {
    return { kind: "not-found" };
  },
  async delete() {
    return { kind: "not-found" };
  },
  ...overrides,
});
