import { NIL_UUID } from "@hot-updater/core";
import {
  createDatabaseClient,
  createStorageDownloadPath,
  createStoragePlugin,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import packageJson from "../package.json" with { type: "json" };
import { createHotUpdater } from "./index";
import type {
  CreateHotUpdaterFeatures,
  CreateHotUpdaterOptions,
  HandlerAPI,
  HandlerOptions,
  HandlerRoutes,
} from "./index";
import {
  createRuntimeDatabase,
  createRuntimeStorage,
  createSchemaManagedDatabase,
  runtimeBundle,
} from "./runtime.testFixtures";
import { HOT_UPDATER_SCHEMA_VERSION } from "./schema/types";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

const updateUrl =
  "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
  `${NIL_UUID}/${NIL_UUID}`;

describe("runtime createHotUpdater", () => {
  it("publishes only the supported runtime and database subpaths", () => {
    const packageExports = packageJson.exports;

    const databaseEntry = packageExports["./db"];
    const hasRuntimeEntry = Object.hasOwn(packageExports, "./runtime");

    expect(databaseEntry).toBeDefined();
    expect(hasRuntimeEntry).toBe(false);
  });

  it("exports runtime-safe handler types from the root entry", () => {
    expectTypeOf<HandlerAPI>().toHaveProperty("getBundles");
    expectTypeOf<HandlerOptions>().toHaveProperty("routes");
    expectTypeOf<keyof HandlerOptions>().toEqualTypeOf<"basePath" | "routes">();
    expectTypeOf<keyof CreateHotUpdaterOptions>().toEqualTypeOf<
      "database" | "features" | "storage" | "basePath"
    >();
    expectTypeOf<keyof CreateHotUpdaterFeatures>().toEqualTypeOf<
      "updateCheck" | "bundles" | "analytics" | "clientAccessKeys"
    >();
    expectTypeOf<HandlerRoutes>().toEqualTypeOf<{
      readonly updateCheck: boolean;
      readonly bundles: boolean;
    }>();
  });

  it("accepts a direct v2 plugin object without exposing maintenance methods", () => {
    const database: DatabasePlugin = {
      ...createInMemoryDatabasePlugin(),
      name: "contextlessTestDatabase",
    };
    const storage = createStoragePlugin({
      name: "contextlessTestStorage",
      protocol: "s3",
      get: async () => ({ response: null }),
      getDownloadUrl: async () => ({
        url: "https://assets.example.com/bundle.zip",
      }),
    });

    const hotUpdater = createHotUpdater({
      database,
      storage: [storage],
    });

    expect(hotUpdater.basePath).toBe("/api");
    expect(hotUpdater.adapterName).toBe("contextlessTestDatabase");
    expect(hotUpdater.handler).toEqual(expect.any(Function));
    expect("createMigrator" in hotUpdater).toBe(false);
    expect("generateSchema" in hotUpdater).toBe(false);
    expectTypeOf(hotUpdater).not.toHaveProperty("createMigrator");
    expectTypeOf(hotUpdater).not.toHaveProperty("generateSchema");
    expectTypeOf(hotUpdater.handler).parameter(0).toEqualTypeOf<Request>();
  });

  it("rejects access when a managed schema is not initialized", async () => {
    const hotUpdater = createHotUpdater({
      database: createSchemaManagedDatabase("kysely", undefined),
    });

    const result = hotUpdater.getBundles({ limit: 10 });

    await expect(result).rejects.toThrow(
      "Hot Updater database schema is not initialized for kysely.",
    );
  });

  it("rejects non-HTTP server storage without getDownloadUrl", () => {
    const storage = createStoragePlugin({
      name: "deployOnlyStorage",
      protocol: "s3",
      get: async () => ({ response: null }),
    });

    expect(() =>
      createHotUpdater({
        database: createRuntimeDatabase(),
        storage: [storage],
      }),
    ).toThrow(
      'Storage plugin "deployOnlyStorage" does not implement getDownloadUrl.',
    );
  });

  it("rejects access when a managed schema is stale", async () => {
    const hotUpdater = createHotUpdater({
      database: createSchemaManagedDatabase("mongodb", "0.21.0"),
    });

    const result = hotUpdater.getChannels();

    await expect(result).rejects.toThrow(
      "Hot Updater database schema version 0.21.0 is not supported by mongodb.",
    );
  });

  it("checks a ready managed schema only once", async () => {
    const database = createSchemaManagedDatabase(
      "kysely",
      HOT_UPDATER_SCHEMA_VERSION,
    );
    const createMigrator = vi.spyOn(database, "createMigrator");
    const hotUpdater = createHotUpdater({ database });

    await hotUpdater.getChannels();
    await hotUpdater.getChannels();

    expect(createMigrator).toHaveBeenCalledOnce();
  });

  it("uses the matching storage plugin to resolve download URLs", async () => {
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
    const assetHost = "https://assets.example.com";
    const resolveUrl = vi.fn(async () => ({
      url: new URL("/bundle.zip", assetHost).toString(),
    }));
    const hotUpdater = createHotUpdater({
      database,
      storage: [createRuntimeStorage(undefined, resolveUrl)],
      basePath: "/api/check-update",
      features: { updateCheck: true, bundles: false },
    });
    const response = await hotUpdater.handler(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      fileUrl: "https://assets.example.com/bundle.zip",
      id: runtimeBundle.id,
      status: "UPDATE",
    });
    expect(getUpdateInfo).toHaveBeenCalledWith(expect.any(Object));
    expect(resolveUrl).toHaveBeenCalledWith({
      storageUri: runtimeBundle.storageUri,
    });
  });

  it("streams storage responses through the built-in delivery route", async () => {
    const database: DatabasePlugin = {
      ...createRuntimeDatabase(),
      getUpdateInfo: async () => ({
        fileHash: runtimeBundle.fileHash,
        id: runtimeBundle.id,
        message: runtimeBundle.message,
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: runtimeBundle.storageUri,
      }),
    };
    const get = vi.fn(
      async () =>
        ({
          response: new Response("bundle bytes", {
            headers: { "content-type": "application/zip" },
          }),
        }) as const,
    );
    const hotUpdater = createHotUpdater({
      database,
      storage: [
        createRuntimeStorage(get, async ({ storageUri }) => ({
          url: createStorageDownloadPath(storageUri, "test-signature"),
        })),
      ],
      basePath: "/api/check-update",
    });

    const updateResponse = await hotUpdater.handler(new Request(updateUrl));
    const update = (await updateResponse.json()) as { fileUrl: string };
    const bundleResponse = await hotUpdater.handler(
      new Request(update.fileUrl),
    );

    expect(bundleResponse.status).toBe(200);
    expect(bundleResponse.headers.get("content-type")).toBe("application/zip");
    expect(bundleResponse.headers.get("cache-control")).toContain("immutable");
    await expect(bundleResponse.text()).resolves.toBe("bundle bytes");
    expect(get).toHaveBeenCalledWith({
      storageUri: runtimeBundle.storageUri,
    });
  });

  it("does not pass handler context to generic database queries", async () => {
    const request = new Request(updateUrl);
    const { getUpdateInfo: ignoredGetUpdateInfo, ...database } =
      createRuntimeDatabase();
    void ignoredGetUpdateInfo;
    await createDatabaseClient(database).insertBundle(runtimeBundle);
    const findMany = vi.spyOn(database.bundles, "findMany");
    const hotUpdater = createHotUpdater({
      database,
      storage: [
        createRuntimeStorage(undefined, async () => ({
          url: "https://assets.example.com/bundle.zip",
        })),
      ],
      basePath: "/api/check-update",
      features: { updateCheck: true, bundles: false },
    });
    const response = await hotUpdater.handler(request);

    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.any(Object));
  });

  it("ignores framework bindings when an extra execution argument is passed", async () => {
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
      storage: [
        createRuntimeStorage(undefined, async () => ({
          url: "https://assets.example.com/bundle.zip",
        })),
      ],
      basePath: "/api/check-update",
      features: { updateCheck: true, bundles: false },
    });
    const request = new Request(updateUrl.replace("/api/check-update", ""));

    const response = await Reflect.apply(hotUpdater.handler, undefined, [
      request,
      { binding: "ignored" },
      { waitUntil: () => undefined },
    ]);

    expect(response.status).toBe(200);
    expect(getUpdateInfo).toHaveBeenCalledWith(expect.any(Object));
  });

  it.each([
    { updateCheck: true, bundles: false },
    { updateCheck: false, bundles: false },
  ])(
    "keeps the version route mounted for $updateCheck/$bundles",
    async (routes) => {
      const hotUpdater = createHotUpdater({
        database: createRuntimeDatabase(),
        basePath: "/api/check-update",
        features: routes,
      });

      const response = await hotUpdater.handler(
        new Request("https://updates.example.com/api/check-update/version"),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        version: HOT_UPDATER_SERVER_VERSION,
      });
    },
  );

  it.each([
    ["updateCheck", "Update-check"],
    ["bundles", "Bundles"],
  ] as const)("rejects a non-boolean %s feature", (feature, label) => {
    expect(() =>
      createHotUpdater({
        database: createRuntimeDatabase(),
        features: { [feature]: "enabled" } as never,
      }),
    ).toThrow(`${label} feature must be a boolean.`);
  });
});
