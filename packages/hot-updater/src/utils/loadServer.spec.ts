import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assembleServer, recordUnsetEnvReads } from "@hot-updater/cli-tools";
import {
  createMemoryAdapter,
  type RemoteDatabase,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import { insights } from "@hot-updater/server/plugins";
import { describe, expect, it, vi } from "vitest";

import { loadServer, ServerConfigError } from "./loadServer";

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
      core: assembleServer({ database: createDatabase(), storage }).core,
      fetchAdmin: vi.fn(async () => new Response(null, { status: 404 })),
      dispose: vi.fn(async () => {}),
    } satisfies RemoteDatabase;

    const server = await loadServer({
      database: remote,
      storage,
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

  it("names a variable the config asserts with process.env and read unset, before any adapter reaches its provider", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-load-server-"),
    );
    await fs.writeFile(path.join(directory, "package.json"), "{}");
    await fs.writeFile(
      path.join(directory, "hot-updater.config.ts"),
      [
        "const token = process.env.HOT_UPDATER_SPEC_API_TOKEN!;",
        "// const old = process.env.HOT_UPDATER_SPEC_COMMENTED!;",
        'const region = process.env.HOT_UPDATER_SPEC_REGION! ?? "auto";',
        'if (process.env.HOT_UPDATER_SPEC_NEVER === "yes") {',
        "  console.log(process.env.HOT_UPDATER_SPEC_BRANCH!);",
        "}",
        "export default { build: () => ({ token, region }) };",
        "",
      ].join("\n"),
    );
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    for (const name of [
      "HOT_UPDATER_SPEC_API_TOKEN",
      "HOT_UPDATER_SPEC_COMMENTED",
      "HOT_UPDATER_SPEC_REGION",
      "HOT_UPDATER_SPEC_NEVER",
      "HOT_UPDATER_SPEC_BRANCH",
    ]) {
      vi.stubEnv(name, undefined);
    }
    try {
      const loaded = loadServer();

      await expect(loaded).rejects.toBeInstanceOf(ServerConfigError);
      await expect(loaded).rejects.toThrow(
        "hot-updater.config reads this with process.env, and it is not set:\nHOT_UPDATER_SPEC_API_TOKEN\nSet it in .env.hotupdater",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      await fs.rm(directory, { force: true, recursive: true });
    }
  });

  it("closes the database the config opened when it refuses an unset variable", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-load-server-"),
    );
    await fs.writeFile(
      path.join(directory, "hot-updater.config.ts"),
      "export const token = process.env.HOT_UPDATER_SPEC_API_TOKEN!;\n",
    );
    await fs.writeFile(path.join(directory, "package.json"), "{}");
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    vi.stubEnv("HOT_UPDATER_SPEC_API_TOKEN", undefined);
    const database = createDatabase();
    const config = { database, storage, plugins: [] };
    recordUnsetEnvReads(config, new Set(["HOT_UPDATER_SPEC_API_TOKEN"]));
    try {
      await expect(loadServer(config)).rejects.toBeInstanceOf(
        ServerConfigError,
      );
      expect(database.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      await fs.rm(directory, { force: true, recursive: true });
    }
  });

  it("needs a database in hot-updater.config.ts", async () => {
    const loaded = loadServer({ storage, plugins: [] });

    await expect(loaded).rejects.toBeInstanceOf(ServerConfigError);
    await expect(loaded).rejects.toThrow(
      "Set database in hot-updater.config.ts: the database your server runs on, such as d1Database(...), or standaloneRepository({ baseUrl }) to reach a self-hosted server through its admin API.",
    );
  });

  it("needs storage in hot-updater.config.ts, and closes the database the config opened", async () => {
    const database = createDatabase();
    const loaded = loadServer({ database, plugins: [] });

    await expect(loaded).rejects.toBeInstanceOf(ServerConfigError);
    await expect(loaded).rejects.toThrow(
      "Set storage in hot-updater.config.ts: where the CLI uploads bundles, such as r2Storage(...).",
    );
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it("closes the database the config opened when its plugins do not assemble", async () => {
    const database = createDatabase();

    await expect(
      loadServer({ database, storage, plugins: [insights(), insights()] }),
    ).rejects.toThrow('Plugin "insights" is registered twice.');
    expect(database.dispose).toHaveBeenCalledOnce();
  });
});
