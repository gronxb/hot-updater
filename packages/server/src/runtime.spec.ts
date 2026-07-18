import { NIL_UUID } from "@hot-updater/core";
import {
  createDatabaseClient,
  type DatabaseAdapter,
  type RuntimeStoragePlugin,
  type RuntimeStorageProfile,
} from "@hot-updater/plugin-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../test-utils/test/inMemoryDatabaseAdapter";
import packageJson from "../package.json" with { type: "json" };
import { createHotUpdater } from "./index";
import type { HandlerAPI, HandlerOptions, HandlerRoutes } from "./index";
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
    expectTypeOf<HandlerOptions>().toHaveProperty("eventIngestion");
    expectTypeOf<HandlerRoutes>().toEqualTypeOf<{
      updateCheck: boolean;
      bundles: boolean;
    }>();
  });

  it("accepts a direct v2 adapter object without exposing maintenance methods", () => {
    // Given
    const database: DatabaseAdapter<undefined> = {
      ...createInMemoryDatabaseAdapter(),
      name: "contextlessTestDatabase",
    };
    const storage = (): RuntimeStoragePlugin<unknown> => ({
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
    const hotUpdater = createHotUpdater({ database, storages: [storage] });

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

  it("passes handler context to the optional update fast-path and storage", async () => {
    // Given
    const request = new Request(updateUrl);
    const getUpdateInfo = vi.fn<
      NonNullable<DatabaseAdapter<TestContext>["getUpdateInfo"]>
    >(async () => ({
      fileHash: runtimeBundle.fileHash,
      id: runtimeBundle.id,
      message: runtimeBundle.message,
      shouldForceUpdate: false,
      status: "UPDATE",
      storageUri: runtimeBundle.storageUri,
    }));
    const database: DatabaseAdapter<TestContext> = {
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
    expect(getUpdateInfo).toHaveBeenCalledWith(expect.any(Object), context);
    expect(getDownloadUrl).toHaveBeenCalledWith(
      runtimeBundle.storageUri,
      context,
    );
  });

  it("passes explicit context to generic low adapter queries", async () => {
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
    expect(findMany).toHaveBeenCalledWith(expect.any(Object), context);
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
    const database: DatabaseAdapter<TestContext> = {
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
    const request = new Request(updateUrl.replace("/api/check-update", ""));

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
      });
    },
  );
});
