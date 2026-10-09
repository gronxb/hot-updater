import {
  type ConfiguredDatabase,
  createEngineDatabase,
  createMemoryAdapter,
  createStorageAdapter,
  type EngineDatabase,
  type HotUpdaterCoreApi,
  HotUpdaterConfigError,
  HotUpdaterSchemaMigrationRequiredError,
  migrateCoreSchema,
  type RemoteDatabase,
} from "@hot-updater/plugin-core";
import { apiKeys, insights } from "@hot-updater/server/plugins";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { assembleServer } from "./assembleServer";
import { provisionClientCredential } from "./serverDefinition";

const memory = (): EngineDatabase => ({
  name: "memory",
  adapter: createMemoryAdapter(),
});

/** Storage that only uploads, as the CLI's credentials may allow. */
const uploads = createStorageAdapter({
  name: "s3Storage",
  protocol: "s3",
  put: async ({ key }) => ({ storageUri: `s3://bucket/${key}` }),
});

const insightsClientPlugin = {
  module: "@hot-updater/react-native",
  name: "insights",
};

describe("assembleServer", () => {
  it("runs core and the plugins over the config's database, as the server does", async () => {
    const database = memory();
    const plugins = [insights(), apiKeys()];

    const server = assembleServer({ database, storage: uploads, plugins });

    expect(server.database).toBe(database);
    expect(server.storage).toBe(uploads);
    expect(server.plugins).toEqual(plugins);
    expect(Object.keys(server.api).sort()).toEqual(["apiKeys", "insights"]);
    expect(server.clientPlugins).toEqual([insightsClientPlugin]);
    expect(server.clientAuth).toEqual({
      plugin: "apiKeys",
      varyHeaders: ["x-api-key"],
    });
    await server.core.ensureChannel("production");
    await expect(server.core.listChannels()).resolves.toMatchObject([
      { name: "production" },
    ]);
  });

  it("leaves client routes public without a plugin that guards them, and needs no storage", () => {
    const server = assembleServer({ database: memory() });

    expect(server.storage).toBeUndefined();
    expect(server.plugins).toEqual([]);
    expect(server.api).toEqual({});
    expect(server.clientPlugins).toEqual([]);
    expect(server).not.toHaveProperty("clientAuth");
  });

  it("stops core until each plugin's tables are migrated, naming the plugins", async () => {
    const adapter = createMemoryAdapter();
    // Core's tables only, as before the config listed its plugins.
    await migrateCoreSchema(adapter, "memory");
    const server = assembleServer({
      database: createEngineDatabase({ name: "memory", adapter }),
      plugins: [insights()],
    });

    const refused = server.core.ensureChannel("production");
    await expect(refused).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    await expect(refused).rejects.toMatchObject({ plugins: ["insights"] });

    await migrateCoreSchema(adapter, "memory", [insights()]);
    await expect(
      server.core.ensureChannel("production"),
    ).resolves.toMatchObject({ name: "production" });
  });

  it("refuses plugins the server refuses", () => {
    const notAPlugin = { id: "notes" } as never;

    expect(() =>
      assembleServer({ database: memory(), plugins: [notAPlugin] }),
    ).toThrow(HotUpdaterConfigError);
    expect(() =>
      assembleServer({ database: memory(), plugins: [apiKeys(), apiKeys()] }),
    ).toThrow('Plugin "apiKeys" is registered twice.');
  });

  it("takes core from standaloneRepository and only checks the plugins, which run on the server", () => {
    const fetchAdmin = vi.fn<RemoteDatabase["fetchAdmin"]>();
    const remote: RemoteDatabase = {
      name: "standalone-repository",
      core: {} as HotUpdaterCoreApi,
      fetchAdmin,
    };

    const server = assembleServer({
      database: remote,
      storage: uploads,
      plugins: [insights(), apiKeys()],
    });

    expect(server.database).toBe(remote);
    expect(server.core).toBe(remote.core);
    expect(server.storage).toBe(uploads);
    expect(server.api).toBeUndefined();
    expect(server.plugins.map(({ id }) => id)).toEqual(["insights", "apiKeys"]);
    expect(server.clientPlugins).toEqual([insightsClientPlugin]);
    expect(server.clientAuth).toEqual({
      plugin: "apiKeys",
      varyHeaders: ["x-api-key"],
    });
    expect(fetchAdmin).not.toHaveBeenCalled();
    expect(() =>
      assembleServer({ database: remote, plugins: [{ id: "notes" } as never] }),
    ).toThrow(HotUpdaterConfigError);
  });

  it("types the plugins' APIs as present over a database the CLI opens itself", () => {
    expectTypeOf(assembleServer({ database: memory() }).api).toEqualTypeOf<
      Readonly<Record<string, unknown>>
    >();
    expectTypeOf(
      assembleServer({ database: memory() as ConfiguredDatabase }).api,
    ).toEqualTypeOf<Readonly<Record<string, unknown>> | undefined>();
    // Managed init provisions the app's credential through it.
    expectTypeOf(
      assembleServer({ database: memory(), plugins: [apiKeys()] }),
    ).toMatchTypeOf<Parameters<typeof provisionClientCredential>[0]>();
  });
});
