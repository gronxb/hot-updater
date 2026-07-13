// @vitest-environment node

import type { NodeStoragePlugin } from "@hot-updater/plugin-core";
import { createDatabaseAdapter } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", () => ({
  loadConfig: loadConfigMock,
}));

const createTestDatabaseAdapter = (name: string) =>
  createDatabaseAdapter({
    name,
    adapter: () => ({
      create: vi.fn(async ({ data }) => data),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
      count: vi.fn(async () => 0),
      findOne: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    }),
  });

function createStoragePlugin(): NodeStoragePlugin {
  return {
    name: "storage",
    supportedProtocol: "s3",
    profiles: {
      node: {
        upload: vi.fn(),
        exists: vi.fn(async () => false),
        delete: vi.fn(),
        downloadFile: vi.fn(),
      },
    },
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  loadConfigMock.mockReset();
});

describe("config.server", () => {
  it("caches the loaded config and reuses its configured database adapter", async () => {
    const database = createTestDatabaseAdapter("db");
    const storagePlugin = createStoragePlugin();
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
    expect(storage).toHaveBeenCalledTimes(1);
    expect(first.databaseClient).toBe(second.databaseClient);
    expect(first.config.database).toBe(database);
    expect(first.storagePlugin).toBe(storagePlugin);
    expect(second.storagePlugin).toBe(storagePlugin);
    expect(isConfigLoaded()).toBe(true);
  });

  it("resets the cached config promise after an initialization failure", async () => {
    const database = createTestDatabaseAdapter("db");
    const storagePlugin = createStoragePlugin();
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
    expect(recovered.config.database).toBe(database);
    expect(recovered.storagePlugin).toBe(storagePlugin);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("requires the configured storage plugin to implement the node profile", async () => {
    const database = createTestDatabaseAdapter("db");
    const storage = vi.fn().mockResolvedValue({
      name: "runtimeOnlyStorage",
      supportedProtocol: "s3",
      profiles: {
        runtime: {
          getDownloadUrl: vi.fn(),
          readText: vi.fn(),
        },
      },
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
      'runtimeOnlyStorage does not implement the node storage profile for protocol "s3".',
    );
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
  });
});
