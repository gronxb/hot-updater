// @vitest-environment node

import type { DatabasePlugin, StoragePlugin } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", () => ({
  loadConfig: loadConfigMock,
}));

function createDatabasePlugin(name: string): DatabasePlugin {
  return {
    name,
    getBundleById: vi.fn(),
    getBundles: vi.fn(),
    getChannels: vi.fn(),
    updateBundle: vi.fn(),
    appendBundle: vi.fn(),
    deleteBundle: vi.fn(),
    commitBundle: vi.fn(),
  };
}

function createStoragePlugin(): StoragePlugin {
  return {
    name: "storage",
    supportedProtocol: "s3",
    upload: vi.fn(),
    delete: vi.fn(),
    getDownloadUrl: vi.fn(),
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  loadConfigMock.mockReset();
});

describe("config.server", () => {
  it("caches the loaded config while creating a fresh database plugin per request", async () => {
    const firstDatabasePlugin = createDatabasePlugin("db-1");
    const secondDatabasePlugin = createDatabasePlugin("db-2");
    const storagePlugin = createStoragePlugin();
    const database = vi
      .fn()
      .mockResolvedValueOnce(firstDatabasePlugin)
      .mockResolvedValueOnce(secondDatabasePlugin);
    const storage = vi.fn().mockResolvedValue(storagePlugin);

    loadConfigMock.mockResolvedValue({
      console: { port: 1422 },
      database,
      storage,
    });

    const { isConfigLoaded, prepareConfig } = await import("./config.server");

    expect(isConfigLoaded()).toBe(false);

    const first = await prepareConfig();
    const second = await prepareConfig();

    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(database).toHaveBeenCalledTimes(2);
    expect(storage).toHaveBeenCalledTimes(1);
    expect(first.databasePlugin).toBe(firstDatabasePlugin);
    expect(second.databasePlugin).toBe(secondDatabasePlugin);
    expect(first.storagePlugin).toBe(storagePlugin);
    expect(second.storagePlugin).toBe(storagePlugin);
    expect(isConfigLoaded()).toBe(true);
  });

  it("resets the cached config promise after an initialization failure", async () => {
    const databasePlugin = createDatabasePlugin("db");
    const storagePlugin = createStoragePlugin();
    const database = vi.fn().mockResolvedValue(databasePlugin);
    const storage = vi.fn().mockResolvedValue(storagePlugin);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    loadConfigMock
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce({
        console: { port: 1422 },
        database,
        storage,
      });

    const { prepareConfig } = await import("./config.server");

    await expect(prepareConfig()).rejects.toThrow("load failed");

    const recovered = await prepareConfig();

    expect(loadConfigMock).toHaveBeenCalledTimes(2);
    expect(recovered.databasePlugin).toBe(databasePlugin);
    expect(recovered.storagePlugin).toBe(storagePlugin);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});
