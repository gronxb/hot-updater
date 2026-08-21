import {
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
} from "./index";
import {
  createRuntimeDatabase,
  createSchemaManagedDatabase,
} from "./runtime.testFixtures";
import { HOT_UPDATER_SCHEMA_VERSION } from "./schema/types";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

const disabledFeatures = {
  clientAccessKeys: false,
} satisfies CreateHotUpdaterFeatures;

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
    expectTypeOf<keyof HandlerOptions>().toEqualTypeOf<"authorityId">();
    expectTypeOf<keyof CreateHotUpdaterOptions>().toEqualTypeOf<
      "authorityId" | "database" | "features" | "storage"
    >();
    expectTypeOf<CreateHotUpdaterOptions>().toHaveProperty("features");
    expectTypeOf<
      CreateHotUpdaterOptions["features"]
    >().toEqualTypeOf<CreateHotUpdaterFeatures>();
    expectTypeOf<
      keyof CreateHotUpdaterFeatures
    >().toEqualTypeOf<"clientAccessKeys">();
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
      features: disabledFeatures,
      storage: [storage],
    });

    expect(hotUpdater.adapterName).toBe("contextlessTestDatabase");
    expect(hotUpdater.handlers.client).toEqual(expect.any(Function));
    expect(hotUpdater.handlers.admin).toEqual(expect.any(Function));
    expect("createMigrator" in hotUpdater).toBe(false);
    expect("generateSchema" in hotUpdater).toBe(false);
    expectTypeOf(hotUpdater).not.toHaveProperty("createMigrator");
    expectTypeOf(hotUpdater).not.toHaveProperty("generateSchema");
    expectTypeOf(hotUpdater.handlers.client)
      .parameter(0)
      .toEqualTypeOf<Request>();
  });

  it("rejects access when a managed schema is not initialized", async () => {
    const hotUpdater = createHotUpdater({
      database: createSchemaManagedDatabase("kysely", undefined),
      features: disabledFeatures,
    });

    const result = hotUpdater.getBundles({ limit: 10 });

    await expect(result).rejects.toThrow(
      "Hot Updater database schema is not initialized for kysely.",
    );
  });

  it.each(["s3", "https"])(
    "rejects registered %s storage without getDownloadUrl",
    (protocol) => {
      const storage = createStoragePlugin({
        name: "deployOnlyStorage",
        protocol,
        get: async () => ({ response: null }),
      });

      expect(() =>
        createHotUpdater({
          database: createRuntimeDatabase(),
          features: disabledFeatures,
          storage: [storage],
        }),
      ).toThrow(
        'Storage plugin "deployOnlyStorage" does not implement getDownloadUrl.',
      );
    },
  );

  it("rejects access when a managed schema is stale", async () => {
    const hotUpdater = createHotUpdater({
      database: createSchemaManagedDatabase("mongodb", "0.21.0"),
      features: disabledFeatures,
    });

    const result = hotUpdater.getChannels();

    await expect(result).rejects.toThrow(
      "Hot Updater v1 cannot migrate schema 0.21.0 in place.",
    );
  });

  it("checks a ready managed schema only once", async () => {
    const database = createSchemaManagedDatabase(
      "kysely",
      HOT_UPDATER_SCHEMA_VERSION,
    );
    const createMigrator = vi.spyOn(database, "createMigrator");
    const hotUpdater = createHotUpdater({
      database,
      features: disabledFeatures,
    });

    await hotUpdater.getChannels();
    await hotUpdater.getChannels();

    expect(createMigrator).toHaveBeenCalledOnce();
  });

  it("keeps the version route mounted on the client handler", async () => {
    const hotUpdater = createHotUpdater({
      database: createRuntimeDatabase(),
      features: disabledFeatures,
    });

    const response = await hotUpdater.handlers.client(
      new Request("https://updates.example.com/version"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      infrastructureGeneration: 1,
      version: HOT_UPDATER_SERVER_VERSION,
    });
  });

  it("rejects a missing features object", () => {
    expect(() =>
      createHotUpdater({
        database: createRuntimeDatabase(),
      } as unknown as CreateHotUpdaterOptions),
    ).toThrow("features must be an object.");
  });

  it("rejects a non-boolean features.clientAccessKeys value", () => {
    expect(() =>
      createHotUpdater({
        database: createRuntimeDatabase(),
        features: {
          clientAccessKeys: "enabled" as unknown as boolean,
        },
      }),
    ).toThrow("features.clientAccessKeys must be a boolean.");
  });
});
