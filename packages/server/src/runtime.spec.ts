import {
  createStoragePlugin,
  type ConfigInput,
} from "@hot-updater/plugin-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import { builtInSettings } from "./database/builtInDatabase";
import { createHotUpdater, HotUpdaterConfigError } from "./index";
import type {
  ClientAccessPolicy,
  CreateHotUpdaterOptions,
  RuntimeHotUpdaterAPI,
} from "./index";
import {
  createFencedDatabase,
  createRuntimeDatabase,
} from "./runtime.testFixtures";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

describe("runtime createHotUpdater", () => {
  it.each(["authorityId", "catalogId"])("rejects a user-supplied %s", (key) => {
    expect(() =>
      createHotUpdater({
        clientAccess: "public",
        database: createRuntimeDatabase(),
        [key]: "user-controlled",
      }),
    ).toThrow(`Remove ${key}`);
  });

  it("publishes only the supported runtime and database subpaths", () => {
    const packageExports = packageJson.exports;

    const databaseEntry = packageExports["./db"];
    const hasRuntimeEntry = Object.hasOwn(packageExports, "./runtime");

    expect(databaseEntry).toBeDefined();
    expect(hasRuntimeEntry).toBe(false);
  });

  it("types the options and the instance without the legacy API", () => {
    expectTypeOf<ConfigInput>().not.toHaveProperty("authorityId");
    expectTypeOf<ConfigInput>().not.toHaveProperty("catalogId");
    expectTypeOf<keyof CreateHotUpdaterOptions>().toEqualTypeOf<
      "clientAccess" | "database" | "plugins" | "storage"
    >();
    expectTypeOf<
      CreateHotUpdaterOptions["clientAccess"]
    >().toEqualTypeOf<ClientAccessPolicy>();
    expectTypeOf<keyof RuntimeHotUpdaterAPI>().toEqualTypeOf<
      "adapterName" | "api" | "core" | "handlers"
    >();
  });

  it("runs on an engine database without exposing its tooling", () => {
    const storage = createStoragePlugin({
      name: "contextlessTestStorage",
      protocol: "s3",
      get: async () => ({ response: null }),
      getDownloadUrl: async () => ({
        url: "https://assets.example.com/bundle.zip",
      }),
    });

    const hotUpdater = createHotUpdater({
      clientAccess: "public",
      database: createRuntimeDatabase("contextlessTestDatabase"),
      storage: [storage],
    });

    expect(hotUpdater.adapterName).toBe("contextlessTestDatabase");
    expect(Object.keys(hotUpdater).sort()).toEqual([
      "adapterName",
      "api",
      "core",
      "handlers",
    ]);
    expect(hotUpdater).not.toHaveProperty("authorityId");
    expectTypeOf(hotUpdater).not.toHaveProperty("createMigrator");
    expectTypeOf(hotUpdater.handlers.client)
      .parameter(0)
      .toEqualTypeOf<Request>();
  });

  it("refuses a database that is not on the storage engine", () => {
    const legacy = { name: "legacy", models: {}, commit: async () => ({}) };
    const remote = {
      name: "standalone",
      core: {},
      fetchAdmin: async () => new Response(null),
    };

    for (const database of [legacy, remote, undefined]) {
      expect(() =>
        createHotUpdater({
          clientAccess: "public",
          database: database as unknown as CreateHotUpdaterOptions["database"],
        }),
      ).toThrow(HotUpdaterConfigError);
    }
    expect(() =>
      createHotUpdater({
        clientAccess: "public",
        database: remote as unknown as CreateHotUpdaterOptions["database"],
      }),
    ).toThrow("standaloneRepository reaches a server's admin API");
  });

  it("answers 503 until the schema settings are written", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const hotUpdater = createHotUpdater({
        clientAccess: "public",
        database: await createFencedDatabase("kysely"),
      });

      const response = await hotUpdater.handlers.admin(
        new Request("https://updates.example.com/channels"),
      );

      expect(response.status).toBe(503);
      await expect(hotUpdater.core.listChannels()).rejects.toThrow(
        "Hot Updater schema setting",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("serves a fenced database once its settings are written", async () => {
    const hotUpdater = createHotUpdater({
      clientAccess: "public",
      database: await createFencedDatabase("kysely", builtInSettings),
    });

    await expect(hotUpdater.core.listChannels()).resolves.toEqual([]);
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
          clientAccess: "public",
          database: createRuntimeDatabase(),
          storage: [storage],
        }),
      ).toThrow(
        'Storage plugin "deployOnlyStorage" does not implement getDownloadUrl.',
      );
    },
  );

  it("keeps the version route mounted on the client handler", async () => {
    const hotUpdater = createHotUpdater({
      clientAccess: "public",
      database: createRuntimeDatabase(),
    });

    const response = await hotUpdater.handlers.client(
      new Request("https://updates.example.com/version"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      adminProtocol: 2,
      infrastructureGeneration: 1,
      version: HOT_UPDATER_SERVER_VERSION,
    });
  });

  it("rejects a missing client access policy", () => {
    expect(() =>
      createHotUpdater({
        database: createRuntimeDatabase(),
      } as unknown as CreateHotUpdaterOptions),
    ).toThrow(
      'Set clientAccess to "public", or add a plugin that provides clientAuth.',
    );
  });

  it("rejects a clientAccess object, naming apiKeys()", () => {
    const withObject = (clientAccess: unknown) => () =>
      createHotUpdater({
        clientAccess: clientAccess as ClientAccessPolicy,
        database: createRuntimeDatabase(),
      });

    expect(withObject({ type: "api-key", headerName: "x-client-key" })).toThrow(
      'clientAccess: { type: "api-key" } was removed in 1.0. Remove it and add apiKeys({ headerName: "x-client-key" }) from @hot-updater/server/plugins/api-keys to plugins',
    );
    expect(withObject({ type: "public" })).toThrow(
      'clientAccess objects were removed in 1.0. Use clientAccess: "public", or add apiKeys()',
    );
    expect(withObject("private")).toThrow(HotUpdaterConfigError);
  });
});
