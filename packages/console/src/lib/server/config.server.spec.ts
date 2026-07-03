// @vitest-environment node

import type {
  DatabasePlugin,
  NodeStoragePlugin,
} from "@hot-updater/plugin-core";
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
    commit: vi.fn(),
    bundles: {
      getBundleById: vi.fn(),
      getBundles: vi.fn(),
      updateBundle: vi.fn(),
      appendBundle: vi.fn(),
      deleteBundle: vi.fn(),
      commit: vi.fn(),
    },
    channels: {
      getChannels: vi.fn(),
    },
  };
}

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

  it("requires the configured storage plugin to implement the node profile", async () => {
    const database = vi.fn().mockResolvedValue(createDatabasePlugin("db"));
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

  it("uses hosted project context without loading a local config file", async () => {
    const databasePlugin = createDatabasePlugin("hosted-db");
    const storagePlugin = createStoragePlugin();
    const { getHostedConsoleInfo, runWithHostedConsoleContext } =
      await import("./hosted-context.server");
    const hostedContext = {
      project: {
        id: "project_001",
        workspaceId: "workspace_001",
        name: "Hosted Project",
      },
      console: {
        gitUrl: "https://github.com/gronxb/hot-updater",
        port: 3000,
      },
      database: vi.fn().mockResolvedValue(databasePlugin),
      storage: vi.fn().mockResolvedValue(storagePlugin),
    };

    const { isConfigLoaded, prepareConfig } = await import("./config.server");

    expect(isConfigLoaded()).toBe(false);

    const prepared = await runWithHostedConsoleContext(
      hostedContext,
      async () => {
        expect(isConfigLoaded()).toBe(true);
        expect(getHostedConsoleInfo()).toEqual({
          mode: "hosted",
          project: {
            id: "project_001",
            workspaceId: "workspace_001",
            name: "Hosted Project",
          },
        });
        return await prepareConfig();
      },
    );

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(prepared.databasePlugin).toBe(databasePlugin);
    expect(prepared.storagePlugin).toBe(storagePlugin);
    expect(prepared.config.console.gitUrl).toBe(
      "https://github.com/gronxb/hot-updater",
    );
    expect(getHostedConsoleInfo()).toEqual({ mode: "local" });
  });
});
