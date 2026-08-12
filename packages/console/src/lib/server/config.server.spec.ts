// @vitest-environment node

import {
  createDatabasePlugin,
  createStoragePlugin,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));

vi.mock("@hot-updater/cli-tools", () => ({
  loadConfig: loadConfigMock,
}));

const createTestDatabasePlugin = (name: string) =>
  createDatabasePlugin({
    name,
    bundles: {
      findById: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    bundlePatches: {
      findByBundleIds: vi.fn(async () => []),
    },
    analytics: {
      append: vi.fn(async () => undefined),
      scan: vi.fn(async () => []),
    },
    clientAccessKeys: {
      create: vi.fn(async () => "created" as const),
      findByHash: vi.fn(async () => null),
      list: vi.fn(async () => []),
      revoke: vi.fn(async () => null),
    },
    commit: vi.fn(async () => ({ applied: true })),
  });

function createTestStoragePlugin() {
  return createStoragePlugin({
    name: "storage",
    protocol: "s3",
    put: vi.fn(),
    get: vi.fn(async () => null),
    delete: vi.fn(),
  });
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  loadConfigMock.mockReset();
});

describe("config.server", () => {
  it("caches the loaded config and reuses its database and runtime clients", async () => {
    const database = createTestDatabasePlugin("db");
    const storagePlugin = createTestStoragePlugin();

    loadConfigMock.mockResolvedValue({
      console: { port: 1422 },
      database,
      storage: storagePlugin,
    });

    const { isConfigLoaded, prepareConfig } = await import("./config.server");

    expect(isConfigLoaded()).toBe(false);

    const first = await prepareConfig();
    const second = await prepareConfig();

    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(first.databaseClient).toBe(second.databaseClient);
    expect(first.config.database).toBe(database);
    expect(first.clientAccessKeyStore).toBe(database.clientAccessKeys);
    expect(second.clientAccessKeyStore).toBe(first.clientAccessKeyStore);
    expect(first.storagePlugin).toBe(storagePlugin);
    expect(second.storagePlugin).toBe(storagePlugin);
    expect(isConfigLoaded()).toBe(true);
  });

  it("resets the cached config promise after an initialization failure", async () => {
    const database = createTestDatabasePlugin("db");
    const storagePlugin = createTestStoragePlugin();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    loadConfigMock
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce({
        console: { port: 1422 },
        database,
        storage: storagePlugin,
      });

    const { prepareConfig } = await import("./config.server");

    await expect(prepareConfig()).rejects.toThrow("load failed");

    const recovered = await prepareConfig();

    expect(loadConfigMock).toHaveBeenCalledTimes(2);
    expect(recovered.config.database).toBe(database);
    expect(recovered.storagePlugin).toBe(storagePlugin);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("reports a missing console storage capability", async () => {
    const database = createTestDatabasePlugin("db");
    const storage = createStoragePlugin({
      name: "runtimeOnlyStorage",
      protocol: "s3",
      get: vi.fn(async () => null),
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    loadConfigMock.mockResolvedValue({
      console: { port: 1422 },
      database,
      storage,
    });

    const { prepareConfig } = await import("./config.server");

    await expect(prepareConfig()).rejects.toThrow(
      'Storage plugin "runtimeOnlyStorage" does not implement put.',
    );
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
  });
});
