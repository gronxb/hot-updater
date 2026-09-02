// @vitest-environment node

import {
  createDatabasePlugin,
  createStoragePlugin,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireConsoleAccessMock, resolveConsoleConfigMock } = vi.hoisted(
  () => ({
    requireConsoleAccessMock: vi.fn(),
    resolveConsoleConfigMock: vi.fn(),
  }),
);

vi.mock("./auth.server", () => ({
  requireConsoleAccess: requireConsoleAccessMock,
}));

vi.mock("./console-runtime.server", () => ({
  resolveConsoleConfig: resolveConsoleConfigMock,
}));

const request = new Request("https://console.example.com/");

const createTestDatabasePlugin = (name: string) =>
  createDatabasePlugin({
    name,
    models: {
      bundles: {
        findById: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
      },
      bundlePatches: {
        findByBundleIds: vi.fn(async () => []),
      },
      releases: {
        findById: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        findManyByScope: vi.fn(async () => []),
      },
      releaseCatalogs: {
        findByScopeKey: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
      },
      channels: {
        insert: vi.fn(async ({ row }) => ({ row, inserted: true })),
        list: vi.fn(async () => ({ channels: [] })),
        delete: vi.fn(async () => ({ deleted: true as const })),
      },
      insights: {
        append: vi.fn(async () => undefined),
        pageEvents: vi.fn(),
        pageInstallations: vi.fn(),
        getReport: vi.fn(),
        pageReport: vi.fn(),
      },
      apiKeys: {
        create: vi.fn(async () => "created" as const),
        findByHash: vi.fn(async () => null),
        list: vi.fn(async () => []),
        revoke: vi.fn(async () => null),
      },
    },
    commit: vi.fn(async () => ({ committed: true as const })),
  });

function createTestStoragePlugin() {
  return createStoragePlugin({
    name: "storage",
    protocol: "s3",
    put: vi.fn(),
    get: vi.fn(async () => ({ response: null })),
    exists: vi.fn(async () => ({ exists: false })),
    delete: vi.fn(async () => ({ deleted: true as const })),
  });
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  requireConsoleAccessMock.mockReset();
  resolveConsoleConfigMock.mockReset();
});

beforeEach(() => {
  requireConsoleAccessMock.mockResolvedValue({
    email: "admin@example.com",
  });
});

describe("config.server", () => {
  it("caches the loaded config and reuses its database and runtime clients", async () => {
    const database = createTestDatabasePlugin("db");
    const storagePlugin = createTestStoragePlugin();

    resolveConsoleConfigMock.mockResolvedValue({
      console: { port: 1422 },
      database,
      storage: storagePlugin,
    });

    const { isConfigLoaded, prepareConfig } = await import("./config.server");

    expect(isConfigLoaded()).toBe(false);

    const first = await prepareConfig(request);
    const second = await prepareConfig(request);

    expect(requireConsoleAccessMock).toHaveBeenCalledTimes(2);
    expect(resolveConsoleConfigMock).toHaveBeenCalledTimes(1);
    expect(first.databaseClient).toBe(second.databaseClient);
    expect(first.config.database).toBe(database);
    expect(first.apiKeyStore).toBe(database.models.apiKeys);
    expect(second.apiKeyStore).toBe(first.apiKeyStore);
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

    resolveConsoleConfigMock
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce({
        console: { port: 1422 },
        database,
        storage: storagePlugin,
      });

    const { prepareConfig } = await import("./config.server");

    await expect(prepareConfig(request)).rejects.toThrow("load failed");

    const recovered = await prepareConfig(request);

    expect(resolveConsoleConfigMock).toHaveBeenCalledTimes(2);
    expect(recovered.config.database).toBe(database);
    expect(recovered.storagePlugin).toBe(storagePlugin);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("reports a missing console storage capability", async () => {
    const database = createTestDatabasePlugin("db");
    const storage = createStoragePlugin({
      name: "runtimeOnlyStorage",
      protocol: "s3",
      get: vi.fn(async () => ({ response: null })),
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    resolveConsoleConfigMock.mockResolvedValue({
      console: { port: 1422 },
      database,
      storage,
    });

    const { prepareConfig } = await import("./config.server");

    await expect(prepareConfig(request)).rejects.toThrow(
      'Storage plugin "runtimeOnlyStorage" does not implement put.',
    );
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
  });

  it("rejects unauthorized requests before resolving runtime config", async () => {
    requireConsoleAccessMock.mockRejectedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { prepareConfig } = await import("./config.server");

    await expect(prepareConfig(request)).rejects.toMatchObject({ status: 401 });

    expect(resolveConsoleConfigMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
