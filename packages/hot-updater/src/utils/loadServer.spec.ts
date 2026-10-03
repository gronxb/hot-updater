import { assembleServer } from "@hot-updater/cli-tools";
import {
  createMemoryAdapter,
  type RemoteDatabase,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import { insights } from "@hot-updater/server/plugins/insights";
import { describe, expect, it, vi } from "vitest";

import { loadServer, requireStorage, ServerConfigError } from "./loadServer";

const createDatabase = () => ({
  name: "memory",
  adapter: createMemoryAdapter(),
  dispose: vi.fn(async () => {}),
});

const storage = {
  name: "r2Storage",
  protocol: "r2",
} as unknown as StorageAdapter;

describe("loadServer", () => {
  it("assembles the server hot-updater.config.ts describes, and closes its database on dispose", async () => {
    const database = createDatabase();

    const server = await loadServer({
      database,
      storage,
      plugins: [insights()],
    });

    expect(server.database).toBe(database);
    expect(server.storage).toBe(storage);
    expect(Object.keys(server.api ?? {})).toEqual(["insights"]);
    expect(server.clientPlugins).toEqual([
      { module: "@hot-updater/react-native", name: "insights" },
    ]);
    expect(database.dispose).not.toHaveBeenCalled();
    await server.dispose();
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it("reaches a self-hosted server through standaloneRepository's core, with no plugin APIs", async () => {
    const remote = {
      name: "standalone",
      core: assembleServer({ database: createDatabase() }).core,
      fetchAdmin: vi.fn(async () => new Response(null, { status: 404 })),
      dispose: vi.fn(async () => {}),
    } satisfies RemoteDatabase;

    const server = await loadServer({
      database: remote,
      plugins: [insights()],
    });

    expect(server.core).toBe(remote.core);
    expect(server.api).toBeUndefined();
    expect(server.clientPlugins).toEqual([
      { module: "@hot-updater/react-native", name: "insights" },
    ]);
    await server.dispose();
    expect(remote.dispose).toHaveBeenCalledOnce();
    expect(remote.fetchAdmin).not.toHaveBeenCalled();
  });

  it("needs a database in hot-updater.config.ts", async () => {
    const loaded = loadServer({ plugins: [] });

    await expect(loaded).rejects.toBeInstanceOf(ServerConfigError);
    await expect(loaded).rejects.toThrow(
      "Set database in hot-updater.config.ts: the database your server runs on, such as d1Database(...), or standaloneRepository({ baseUrl }) to reach a self-hosted server through its admin API.",
    );
  });

  it("closes the database the config opened when its plugins do not assemble", async () => {
    const database = createDatabase();

    await expect(
      loadServer({ database, plugins: [insights(), insights()] }),
    ).rejects.toThrow('Plugin "insights" is registered twice.');
    expect(database.dispose).toHaveBeenCalledOnce();
  });
});

describe("requireStorage", () => {
  it("is the config's storage, or an error that says to set one", () => {
    expect(requireStorage({ storage })).toBe(storage);
    expect(() => requireStorage({ storage: undefined })).toThrow(
      "Set storage in hot-updater.config.ts: where the CLI uploads bundles, such as r2Storage(...).",
    );
  });
});
