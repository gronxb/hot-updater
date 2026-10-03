import {
  createEngineDatabase,
  createMemoryAdapter,
  createStorageAdapter,
  type DatabaseAdapter,
  type Deployment,
} from "@hot-updater/plugin-core";
import { NIL_UUID } from "@hot-updater/protocol";
import { createBundleFixture } from "@hot-updater/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "./createHotUpdaterCore";
import { apiKeys } from "./plugins/api-keys";
import { definePlugin } from "./plugins/definePlugin";
import { insights } from "./plugins/insights";
import { createMigrator } from "./tooling.testFixtures";

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {},
  init: () => ({
    api: {},
    endpoints: [
      {
        method: "GET",
        path: "/notes/:id",
        access: "client",
        handler: async () => Response.json({}),
      },
      {
        method: "DELETE",
        path: "/notes/:id",
        access: "admin",
        handler: async () => Response.json({}),
      },
    ],
  }),
  cli: { clientPlugin: { module: "notes-client", name: "notes" } },
});

const bundle = createBundleFixture("1");

const deployment: Deployment = {
  bundle,
  release: {
    channel: "production",
    enabled: true,
    fingerprintHash: null,
    message: null,
    shouldForceUpdate: false,
    targetAppVersion: "*",
  },
};

/** Storage that only uploads, as the CLI's credentials for a managed server allow. */
const uploads = createStorageAdapter({
  name: "uploads",
  protocol: "r2",
  put: async () => ({ storageUri: "r2://bucket/key" }),
});

/** An adapter that records the name of every method called on it. */
const recording = (adapter: DatabaseAdapter) => {
  const calls: string[] = [];
  const proxy = new Proxy(adapter, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" && typeof key === "string"
        ? (...args: unknown[]) => {
            calls.push(key);
            return value.apply(target, args);
          }
        : value;
    },
  });
  return { adapter: proxy, calls };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a server definition", () => {
  it("exposes the database, storage, and plugins as configured", () => {
    const database = { name: "memory", adapter: createMemoryAdapter() };
    const storage = [uploads];
    const plugins = [insights(), notes] as const;

    const hotUpdater = createHotUpdater({
      database,
      storage,
      plugins,
      clientAccess: "public",
    });

    expect(hotUpdater.database).toBe(database);
    expect(hotUpdater.storage).toEqual([uploads]);
    expect(hotUpdater.plugins).toEqual(plugins);
    // What init prints for the app, each once.
    expect(hotUpdater.clientPlugins).toEqual([
      { module: "@hot-updater/react-native", name: "insights" },
      { module: "notes-client", name: "notes" },
    ]);
    // A host that routes by path sends these to the server; admin ones stay behind it.
    expect(hotUpdater.clientEndpoints).toEqual([
      { plugin: "insights", method: "POST", path: "/events" },
      { plugin: "notes", method: "GET", path: "/notes/:id" },
    ]);
    expect(hotUpdater.clientAuth).toBeUndefined();

    // Frozen copies: changing the arrays passed in changes nothing it lists.
    storage.push(uploads);
    (plugins as unknown as unknown[]).pop();
    expect(hotUpdater.storage).toEqual([uploads]);
    expect(hotUpdater.plugins.map(({ id }) => id)).toEqual([
      "insights",
      "notes",
    ]);
    expect(Object.isFrozen(hotUpdater.storage)).toBe(true);
    expect(Object.isFrozen(hotUpdater.plugins)).toBe(true);
  });

  it("names the plugin that guards client routes and the headers its decision reads, lowercase", () => {
    const hotUpdater = createHotUpdater({
      database: { name: "memory", adapter: createMemoryAdapter() },
      plugins: [apiKeys({ headerName: "X-Hot-Updater-Key" })],
    });

    expect(hotUpdater.clientAuth).toEqual({
      plugin: "apiKeys",
      varyHeaders: ["x-hot-updater-key"],
    });
    expect(Object.isFrozen(hotUpdater.clientAuth?.varyHeaders)).toBe(true);
    expect(Object.isFrozen(hotUpdater.clientEndpoints)).toBe(true);
  });

  it("starts its plugins without reading or writing the database", () => {
    const { adapter, calls } = recording(createMemoryAdapter());

    for (const aggregateBatching of [
      undefined,
      { mode: "log" },
      { mode: "memory" },
    ] as const) {
      createHotUpdater({
        database: {
          name: "recording",
          adapter,
          ...(aggregateBatching === undefined ? {} : { aggregateBatching }),
        },
        plugins: [insights(), apiKeys()],
      });
    }

    expect(calls).toEqual([]);
  });

  it("writes through core with storage that only uploads, resolves no artifacts on it, and refuses to serve with it", async () => {
    const database = createEngineDatabase({
      name: "memory",
      adapter: createMemoryAdapter(),
    });
    await createMigrator(createHotUpdater({ database, clientAccess: "public" }))
      .migrateToLatest({ mode: "from-schema", updateSettings: true })
      .then((result) => result.execute());
    const hotUpdater = createHotUpdater({
      database,
      storage: [uploads],
      plugins: [insights()],
      clientAccess: "public",
    });
    await createMigrator(hotUpdater)
      .migrateToLatest({ mode: "from-schema", updateSettings: true })
      .then((result) => result.execute());

    // What the CLI's deploy, promote, and delete do: no file is read.
    const [result] = await hotUpdater.core.deploy([deployment]);
    const releaseId = result!.release!.id;
    await hotUpdater.core.updateReleasePolicy({
      releaseId,
      patch: { enabled: false },
    });
    await expect(hotUpdater.core.getRelease(releaseId)).resolves.toMatchObject({
      enabled: false,
    });
    await hotUpdater.core.deleteRelease({ releaseId });
    await expect(hotUpdater.core.getRelease(releaseId)).resolves.toBeNull();

    // Storage that can neither read nor sign a file gives no artifacts.
    const stored = {
      ...createBundleFixture("2"),
      manifestStorageUri: "r2://bucket/bundles/2/manifest.json",
      assetBaseStorageUri: "r2://bucket/assets",
    };
    await hotUpdater.core.deploy([{ ...deployment, bundle: stored }]);
    await expect(
      hotUpdater.core.getArtifactInfo(stored.id, NIL_UUID, 1),
    ).resolves.toBeNull();

    expect(() => hotUpdater.handlers).toThrow("uploads");
  });

  it("keeps a write when the retention pass before it fails, and hands the pass to the next writer that can delete", async () => {
    const memory = createMemoryAdapter();
    // The CLI's credentials cannot delete; the server's, on the same
    // database, can.
    const hotUpdater = createHotUpdater({
      database: createEngineDatabase({
        name: "memory",
        adapter: {
          ...memory,
          prune: async () => {
            throw new Error("AccessDenied: no delete permission");
          },
        },
      }),
      plugins: [insights()],
      clientAccess: "public",
    });
    const prune = vi.fn(async () => 0);
    const server = createHotUpdater({
      database: createEngineDatabase({
        name: "memory",
        adapter: { ...memory, prune },
      }),
      plugins: [insights()],
      clientAccess: "public",
    });
    await createMigrator(hotUpdater)
      .migrateToLatest({ mode: "from-schema", updateSettings: true })
      .then((result) => result.execute());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const [result] = await hotUpdater.core.deploy([deployment]);

    expect(result?.release?.bundle_id).toBe(bundle.id);
    expect(warn).toHaveBeenCalledWith(
      "[hot-updater] Pruning expired rows failed.",
      expect.objectContaining({
        message: "AccessDenied: no delete permission",
      }),
    );
    // The lease is due again, so the server's next write runs the pass
    // rather than an hour later.
    await server.core.deploy([
      { ...deployment, bundle: createBundleFixture("2") },
    ]);
    expect(prune).toHaveBeenCalled();
  });
});
