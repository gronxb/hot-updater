import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockServer, mockStoragePlugin } = vi.hoisted(() => ({
  mockCli: {
    loadConfig: vi.fn(),
    p: {
      isCancel: vi.fn(() => false),
      log: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      note: vi.fn(),
      outro: vi.fn(),
    },
  },
  mockServer: {
    createBundleDiff: vi.fn(),
  },
  mockStoragePlugin: {
    name: "mock-storage",
  },
}));

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

describe("createPatch cleanup precedence", () => {
  const lifecycle: string[] = [];
  const disposeStorage = vi.fn(async () => {
    lifecycle.push("storage:dispose");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    lifecycle.length = 0;
    databaseHarness.onUnmount.mockImplementation(async () => {
      lifecycle.push("database:dispose");
    });
    mockServer.createBundleDiff.mockImplementation(async () => {
      lifecycle.push("diff");
      return { id: "target-bundle" };
    });
    mockCli.loadConfig.mockResolvedValue({
      database: databaseHarness.plugin,
      disposeStorage,
      storage: vi.fn(async () => {
        lifecycle.push("storage:init");
        return mockStoragePlugin;
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("throws the storage cleanup error after database cleanup on success", async () => {
    const storageCleanupError = new Error("storage cleanup failed");
    disposeStorage.mockImplementationOnce(async () => {
      lifecycle.push("storage:dispose");
      throw storageCleanupError;
    });

    await expect(createPatch(patchOptions)).rejects.toBe(storageCleanupError);

    expect(lifecycle).toEqual([
      "storage:init",
      "diff",
      "storage:dispose",
      "database:dispose",
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("throws the database cleanup error when it is the only failure", async () => {
    const databaseCleanupError = new Error("database cleanup failed");
    databaseHarness.onUnmount.mockImplementationOnce(async () => {
      lifecycle.push("database:dispose");
      throw databaseCleanupError;
    });

    await expect(createPatch(patchOptions)).rejects.toBe(databaseCleanupError);

    expect(lifecycle).toEqual([
      "storage:init",
      "diff",
      "storage:dispose",
      "database:dispose",
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("preserves the first cleanup error and warns for the later failure", async () => {
    const storageCleanupError = new Error("storage cleanup failed");
    const databaseCleanupError = new Error("database cleanup failed");
    disposeStorage.mockImplementationOnce(async () => {
      lifecycle.push("storage:dispose");
      throw storageCleanupError;
    });
    databaseHarness.onUnmount.mockImplementationOnce(async () => {
      lifecycle.push("database:dispose");
      throw databaseCleanupError;
    });

    await expect(createPatch(patchOptions)).rejects.toBe(storageCleanupError);

    expect(mockCli.p.log.warn).toHaveBeenCalledOnce();
    expect(mockCli.p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining(databaseCleanupError.message),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("preserves an undefined first cleanup failure by identity", async () => {
    const databaseCleanupError = new Error("database cleanup failed");
    disposeStorage.mockImplementationOnce(async () => {
      lifecycle.push("storage:dispose");
      throw undefined;
    });
    databaseHarness.onUnmount.mockImplementationOnce(async () => {
      lifecycle.push("database:dispose");
      throw databaseCleanupError;
    });

    await expect(createPatch(patchOptions)).rejects.toBeUndefined();

    expect(mockCli.p.log.warn).toHaveBeenCalledOnce();
    expect(mockCli.p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining(databaseCleanupError.message),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("preserves the diff error and warns for both cleanup failures", async () => {
    const diffError = new Error("diff failed");
    const storageCleanupError = new Error("storage cleanup failed");
    const databaseCleanupError = new Error("database cleanup failed");
    mockServer.createBundleDiff.mockImplementationOnce(async () => {
      lifecycle.push("diff");
      throw diffError;
    });
    disposeStorage.mockImplementationOnce(async () => {
      lifecycle.push("storage:dispose");
      throw storageCleanupError;
    });
    databaseHarness.onUnmount.mockImplementationOnce(async () => {
      lifecycle.push("database:dispose");
      throw databaseCleanupError;
    });

    await createPatch(patchOptions);

    expect(console.error).toHaveBeenCalledWith(diffError);
    expect(process.exitCode).toBe(1);
    expect(mockCli.p.log.warn).toHaveBeenCalledTimes(2);
    expect(mockCli.p.log.warn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(storageCleanupError.message),
    );
    expect(mockCli.p.log.warn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(databaseCleanupError.message),
    );
    expect(lifecycle).toEqual([
      "storage:init",
      "diff",
      "storage:dispose",
      "database:dispose",
    ]);
  });
});
