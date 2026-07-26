import type { StorageOperationContext } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockServer, mockStoragePlugin } = vi.hoisted(() => {
  const mockStoragePlugin = {
    name: "mock-storage",
  };
  const mockServer = {
    createBundleDiff: vi.fn(),
  };
  const mockCli = {
    loadConfig: vi.fn(),
    p: {
      isCancel: vi.fn(),
      log: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      note: vi.fn(),
      outro: vi.fn(),
    },
  };

  return {
    mockCli,
    mockServer,
    mockStoragePlugin,
  };
});

vi.mock("@hot-updater/cli-tools", () => ({
  loadConfig: mockCli.loadConfig,
  p: mockCli.p,
}));

vi.mock("@hot-updater/server/db", () => ({
  createBundleDiff: mockServer.createBundleDiff,
}));

vi.mock("@/prompts/getPlatform", () => ({
  getPlatform: vi.fn(),
}));

vi.mock("@/utils/printBanner", () => ({
  printBanner: vi.fn(),
}));

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";
import { createPatch } from "./patch";

const databaseHarness = createDatabasePluginHarness();
const patchOptions = {
  baseBundleId: "base-bundle",
  bundleId: "target-bundle",
  channel: "production",
  interactive: false,
  platform: "ios",
} as const;

describe("createPatch", () => {
  const lifecycle: string[] = [];
  const storageContexts: StorageOperationContext[] = [];
  const storage = vi.fn(async (context: StorageOperationContext) => {
    lifecycle.push("storage:init");
    storageContexts.push(context);
    return mockStoragePlugin;
  });
  const disposeStorage = vi.fn(async () => {
    lifecycle.push("storage:dispose");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    lifecycle.length = 0;
    storageContexts.length = 0;

    databaseHarness.onUnmount.mockImplementation(async () => {
      lifecycle.push("database:dispose");
    });
    mockCli.p.isCancel.mockReturnValue(false);
    mockServer.createBundleDiff.mockImplementation(async () => {
      lifecycle.push("diff");
      return { id: "target-bundle" };
    });
    mockCli.loadConfig.mockResolvedValue({
      database: databaseHarness.plugin,
      disposeStorage,
      storage,
    });
  });

  afterEach(() => {
    delete process.env["HOT_UPDATER_PATCH_CONTEXT_TEST"];
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("creates a manual patch with one bound frozen Node context", async () => {
    process.env["HOT_UPDATER_PATCH_CONTEXT_TEST"] = "context-value";

    await createPatch(patchOptions);

    expect(mockCli.loadConfig).toHaveBeenCalledWith({
      channel: "production",
      platform: "ios",
    });
    expect(storage).toHaveBeenCalledOnce();
    const context = storageContexts[0];
    expect(context).toBeDefined();
    expect(context).toEqual({
      target: "node",
      environment: expect.objectContaining({
        HOT_UPDATER_PATCH_CONTEXT_TEST: "context-value",
      }),
      bindings: {},
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context?.environment)).toBe(true);
    expect(Object.isFrozen(context?.bindings)).toBe(true);
    expect(mockServer.createBundleDiff).toHaveBeenCalledWith(
      {
        baseBundleId: "base-bundle",
        bundleId: "target-bundle",
      },
      {
        databasePlugin: databaseHarness.plugin,
        storagePlugin: mockStoragePlugin,
      },
      {
        makePrimary: true,
      },
    );
    expect(mockCli.p.outro).toHaveBeenCalledWith(
      "⚡ Patch Ready (target-bundle)",
    );
    expect(lifecycle).toEqual([
      "storage:init",
      "diff",
      "storage:dispose",
      "database:dispose",
    ]);
  });

  it("does not load config or storage when platform validation fails", async () => {
    await createPatch({
      ...patchOptions,
      platform: undefined,
    });

    expect(mockCli.loadConfig).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect(disposeStorage).not.toHaveBeenCalled();
    expect(databaseHarness.onUnmount).not.toHaveBeenCalled();
  });

  it("does not initialize storage when config loading fails", async () => {
    const configError = new Error("config failed");
    mockCli.loadConfig.mockRejectedValueOnce(configError);

    await expect(createPatch(patchOptions)).rejects.toBe(configError);

    expect(storage).not.toHaveBeenCalled();
    expect(disposeStorage).not.toHaveBeenCalled();
    expect(databaseHarness.onUnmount).not.toHaveBeenCalled();
  });

  it("disposes the response and database when storage initialization fails", async () => {
    const initError = new Error("storage init failed");
    storage.mockImplementationOnce(async () => {
      lifecycle.push("storage:init");
      throw initError;
    });

    await expect(createPatch(patchOptions)).rejects.toBe(initError);

    expect(mockServer.createBundleDiff).not.toHaveBeenCalled();
    expect(disposeStorage).toHaveBeenCalledOnce();
    expect(databaseHarness.onUnmount).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual([
      "storage:init",
      "storage:dispose",
      "database:dispose",
    ]);
  });

  it("awaits both cleanups before exiting after a diff failure", async () => {
    const diffError = new Error("diff failed");
    mockServer.createBundleDiff.mockImplementationOnce(async () => {
      lifecycle.push("diff");
      throw diffError;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await createPatch(patchOptions);

    expect(errorSpy).toHaveBeenCalledWith(diffError);
    expect(process.exitCode).toBe(1);
    expect(lifecycle).toEqual([
      "storage:init",
      "diff",
      "storage:dispose",
      "database:dispose",
    ]);
  });
});
