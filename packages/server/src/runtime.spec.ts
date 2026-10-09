import {
  createStorageAdapter,
  type ConfigInput,
  coreSettings,
} from "@hot-updater/plugin-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import packageJson from "../package.json" with { type: "json" };
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

  it.each([
    ["storages", "Rename storages to storage"],
    ["storagePlugins", "Rename storagePlugins to storage"],
    ["basePath", "Remove basePath"],
    ["cwd", "Remove cwd"],
  ])("rejects the removed %s, which it would otherwise ignore", (key, fix) => {
    // Built in a variable, as plain JavaScript or a spread passes them.
    const options = {
      clientAccess: "public",
      database: createRuntimeDatabase(),
      [key]: key === "basePath" ? "/hot-updater" : [],
    } as const;

    expect(() => createHotUpdater(options)).toThrow(fix);
  });

  it("publishes the runtime, the built-in adapters, and the built-in plugins, and no tooling entry", () => {
    // Tooling reads a server through its definition's properties instead.
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      ".",
      "./adapters/drizzle",
      "./adapters/kysely",
      "./adapters/mongodb",
      "./adapters/prisma",
      "./package.json",
      "./plugins",
    ]);
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
      | "adapterName"
      | "api"
      | "clientAuth"
      | "clientEndpoints"
      | "clientPlugins"
      | "core"
      | "database"
      | "flush"
      | "handlers"
      | "plugins"
      | "storage"
    >();
  });

  it("runs on an engine database, which it exposes as configured rather than as methods", () => {
    const storage = createStorageAdapter({
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
    // Public client routes: no clientAuth.
    expect(Object.keys(hotUpdater).sort()).toEqual([
      "adapterName",
      "api",
      "clientEndpoints",
      "clientPlugins",
      "core",
      "database",
      "flush",
      "handlers",
      "plugins",
      "storage",
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
      database: await createFencedDatabase("kysely", coreSettings),
    });

    await expect(hotUpdater.core.listChannels()).resolves.toEqual([]);
  });

  it.each(["s3", "https"])(
    "rejects registered %s storage without getDownloadUrl where the handlers are mounted",
    (protocol) => {
      const storage = createStorageAdapter({
        name: "deployOnlyStorage",
        protocol,
        get: async () => ({ response: null }),
      });
      // Tooling reads the definition, whose storage may only upload.
      const hotUpdater = createHotUpdater({
        clientAccess: "public",
        database: createRuntimeDatabase(),
        storage: [storage],
      });

      expect(() => hotUpdater.handlers).toThrow(
        'Storage adapter "deployOnlyStorage" does not implement getDownloadUrl.',
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

  it("rejects a clientAccess object, naming what replaced it", () => {
    const withObject = (clientAccess: unknown) => () =>
      createHotUpdater({
        clientAccess: clientAccess as ClientAccessPolicy,
        database: createRuntimeDatabase(),
      });
    const removed =
      'clientAccess objects were removed in 1.0. Set clientAccess: "public", or add a plugin that provides clientAuth to plugins.';

    expect(withObject({ type: "api-key", headerName: "x-client-key" })).toThrow(
      removed,
    );
    expect(withObject({ type: "public" })).toThrow(removed);
    expect(withObject("private")).toThrow(
      'clientAccess must be "public"; to protect client routes, add a plugin that provides clientAuth to plugins.',
    );
  });
});
