// @vitest-environment node

import {
  createStorageAdapter,
  createMemoryAdapter,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
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

const createTestDatabase = (name: string) => ({
  name,
  adapter: createMemoryAdapter(),
});

function createTestStorageAdapter() {
  return createStorageAdapter({
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
  it("caches the loaded config and reuses core and the runtime", async () => {
    const database = createTestDatabase("db");
    const storageAdapter = createTestStorageAdapter();
    const plugins = [apiKeys()];
    const server = createHotUpdater({
      database,
      storage: [storageAdapter],
      plugins,
    });

    resolveConsoleConfigMock.mockResolvedValue({
      database,
      core: server.core,
      plugins,
      api: server.api,
      storage: [storageAdapter],
    });

    const { isConfigLoaded, prepareConfig } = await import("./config.server");

    expect(isConfigLoaded()).toBe(false);

    const first = await prepareConfig(request);
    const second = await prepareConfig(request);

    expect(requireConsoleAccessMock).toHaveBeenCalledTimes(2);
    expect(resolveConsoleConfigMock).toHaveBeenCalledTimes(1);
    // The definition's core: the console writes on the server's own path.
    expect(first.core).toBe(server.core);
    expect(second.core).toBe(server.core);
    expect(first.config.database).toBe(database);
    expect(second.runtime).toBe(first.runtime);
    await expect(first.runtime.features()).resolves.toEqual({
      insights: false,
      insightsAnalytics: false,
      apiKeys: true,
    });
    await expect(first.core.listChannels()).resolves.toEqual([]);
    expect(first.storage).toEqual([storageAdapter]);
    expect(second.storage).toEqual([storageAdapter]);
    expect(isConfigLoaded()).toBe(true);
  });

  it("reads a self-hosted server's plugins once, when the features are first asked for", async () => {
    const fetchAdmin = vi.fn(async () =>
      Response.json({ adminProtocol: 2, plugins: ["insights"] }),
    );
    const storage = [createTestStorageAdapter()];
    resolveConsoleConfigMock.mockResolvedValue({
      database: {
        name: "standalone-repository",
        url: "https://updates.example.com/hot-updater/admin",
        core: {},
        fetchAdmin,
        storage,
      },
      storage,
    });

    const { prepareConfig } = await import("./config.server");
    const { runtime } = await prepareConfig(request);

    expect(runtime.remote).toBe(true);
    expect(fetchAdmin).not.toHaveBeenCalled();
    await expect(runtime.features()).resolves.toEqual({
      insights: true,
      insightsAnalytics: false,
      apiKeys: false,
    });
    await (await prepareConfig(request)).runtime.features();
    expect(fetchAdmin).toHaveBeenCalledOnce();
    expect(fetchAdmin).toHaveBeenCalledWith("/version");
  });

  it("resets the cached config promise after an initialization failure", async () => {
    const database = createTestDatabase("db");
    const storageAdapter = createTestStorageAdapter();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    resolveConsoleConfigMock
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce({
        database,
        storage: [storageAdapter],
      });

    const { prepareConfig } = await import("./config.server");

    await expect(prepareConfig(request)).rejects.toThrow("load failed");

    const recovered = await prepareConfig(request);

    expect(resolveConsoleConfigMock).toHaveBeenCalledTimes(2);
    expect(recovered.config.database).toBe(database);
    expect(recovered.storage).toEqual([storageAdapter]);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("reads and deletes with storage that does not upload", async () => {
    const database = createTestDatabase("db");
    const storage = createStorageAdapter({
      name: "runtimeOnlyStorage",
      protocol: "s3",
      get: vi.fn(async () => ({ response: null })),
    });
    resolveConsoleConfigMock.mockResolvedValue({
      database,
      storage: [storage],
    });

    const { prepareConfig } = await import("./config.server");

    // The console never uploads, so the server's storage serves it as is.
    await expect(prepareConfig(request)).resolves.toMatchObject({
      storage: [storage],
    });
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

  it("reports a server it cannot read, and reads it again on the next request", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    resolveConsoleConfigMock.mockRejectedValueOnce(
      new Error(
        "The console's server comes from an older @hot-updater/server. Upgrade @hot-updater/server to the version of @hot-updater/console.",
      ),
    );

    const { prepareConfig } = await import("./config.server");

    await expect(prepareConfig(request)).rejects.toThrow(
      "Upgrade @hot-updater/server to the version of @hot-updater/console.",
    );
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    resolveConsoleConfigMock.mockResolvedValue({
      database: createTestDatabase("db"),
      core: {},
      storage: [],
    });
    await expect(prepareConfig(request)).resolves.toMatchObject({
      storage: [],
    });
  });
});
