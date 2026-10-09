// @vitest-environment node

import { mockStorage } from "@hot-updater/mock";
import {
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
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys, insights } from "@hot-updater/server/plugins";
import { describe, expect, it, vi } from "vitest";

import type { HotUpdaterConsoleConfigSource } from "../../index";
import { resolveConsoleConfig } from "./console-runtime.server";

const configModule = vi.hoisted(() => ({
  source: undefined as HotUpdaterConsoleConfigSource | undefined,
}));

vi.mock("virtual:hot-updater-console/config", () => ({
  get default() {
    return configModule.source;
  },
}));

const request = new Request("https://console.example.com/");
// Storage the console only reads bundle files with: assembling needs no more.
const storage = createStorageAdapter({ name: "s3Storage", protocol: "s3" });

const memory = (): EngineDatabase => ({
  name: "memory",
  adapter: createMemoryAdapter(),
});

describe("Console config resolution", () => {
  it.each(["object", "callback"])(
    "assembles a %s config's database, storage, and plugins as the server does",
    async (sourceType) => {
      const database = memory();
      const plugins = [insights(), apiKeys()];
      const config = {
        database,
        storage,
        plugins,
        console: { gitUrl: "https://github.com/example/app" },
      };
      const source = vi.fn(async () => config);
      configModule.source = sourceType === "object" ? config : source;

      const resolved = await resolveConsoleConfig(request);

      expect(resolved).toMatchObject({
        gitUrl: "https://github.com/example/app",
        database,
        storage,
        plugins,
      });
      expect(Object.keys(resolved.api ?? {}).sort()).toEqual([
        "apiKeys",
        "insights",
      ]);
      // The console writes through core over the server's own tables.
      await resolved.core.ensureChannel("production");
      await expect(
        createHotUpdater({
          database,
          storage: mockStorage({}),
          plugins,
        }).core.listChannels(),
      ).resolves.toMatchObject([{ name: "production" }]);
      if (sourceType === "callback") {
        expect(source).toHaveBeenCalledWith(request);
      }
    },
  );

  it("runs no plugins when the config lists none", async () => {
    configModule.source = { database: memory(), storage };

    const resolved = await resolveConsoleConfig(request);

    expect(resolved.plugins).toEqual([]);
    expect(resolved.api).toEqual({});
    expect(resolved).not.toHaveProperty("gitUrl");
  });

  it("refuses the plugins the server refuses", async () => {
    configModule.source = {
      database: memory(),
      storage,
      plugins: [{ id: "notes" } as never],
    };
    await expect(resolveConsoleConfig(request)).rejects.toBeInstanceOf(
      HotUpdaterConfigError,
    );

    // insights() without its factory's mark.
    configModule.source = {
      database: memory(),
      storage,
      plugins: [{ ...insights() }],
    };
    await expect(resolveConsoleConfig(request)).rejects.toThrow(
      "which is reserved for Hot Updater's insights() plugin",
    );
  });

  it("stops core until each listed plugin's tables are migrated, as the server does", async () => {
    const adapter = createMemoryAdapter();
    // Core's tables only, as before the config listed insights().
    await migrateCoreSchema(adapter, "memory");
    configModule.source = {
      database: createEngineDatabase({ name: "memory", adapter }),
      storage,
      plugins: [insights()],
    };

    const { core } = await resolveConsoleConfig(request);

    const refused = core.ensureChannel("production");
    await expect(refused).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    await expect(refused).rejects.toMatchObject({ plugins: ["insights"] });
    await migrateCoreSchema(adapter, "memory", [insights()]);
    await expect(core.ensureChannel("production")).resolves.toMatchObject({
      name: "production",
    });
  });

  it("takes core from standaloneRepository, whose server runs the plugins", async () => {
    const database: RemoteDatabase = {
      name: "standalone-repository",
      core: {} as HotUpdaterCoreApi,
      fetchAdmin: vi.fn(),
    };
    const plugins = [insights()];
    configModule.source = { database, storage, plugins };

    await expect(resolveConsoleConfig(request)).resolves.toEqual({
      database,
      core: database.core,
      storage,
      plugins,
    });
    expect(database.fetchAdmin).not.toHaveBeenCalled();
  });

  it("refuses over standaloneRepository the plugins the server refuses", async () => {
    const database: RemoteDatabase = {
      name: "standalone-repository",
      core: {} as HotUpdaterCoreApi,
      fetchAdmin: vi.fn(),
    };
    // insights() without its factory's mark.
    configModule.source = { database, storage, plugins: [{ ...insights() }] };

    await expect(resolveConsoleConfig(request)).rejects.toThrow(
      "which is reserved for Hot Updater's insights() plugin",
    );
    expect(database.fetchAdmin).not.toHaveBeenCalled();
  });
});
