import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockDatabasePlugin, mockServer, mockStoragePlugin } =
  vi.hoisted(() => {
    const mockDatabasePlugin = {
      close: vi.fn(),
      onUnmount: vi.fn(),
    };
    const mockStoragePlugin = {
      name: "mock-storage",
    };
    const mockServer = {
      createBundleDiff: vi.fn(),
    };
    const mockCli = {
      disposeLoadedDatabase: vi.fn(
        async (database: { close?: () => Promise<void> }) => database.close?.(),
      ),
      loadConfig: vi.fn(),
      p: {
        isCancel: vi.fn(),
        log: {
          error: vi.fn(),
        },
        note: vi.fn(),
        outro: vi.fn(),
      },
    };

    return {
      mockCli,
      mockDatabasePlugin,
      mockServer,
      mockStoragePlugin,
    };
  });

vi.mock("@hot-updater/cli-tools", () => ({
  disposeLoadedDatabase: mockCli.disposeLoadedDatabase,
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

import { createPatch } from "./patch";

describe("createPatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockCli.p.isCancel.mockReturnValue(false);
    mockDatabasePlugin.close.mockResolvedValue(undefined);
    mockDatabasePlugin.onUnmount.mockResolvedValue(undefined);
    mockServer.createBundleDiff.mockResolvedValue({
      id: "target-bundle",
    });
    mockCli.loadConfig.mockResolvedValue({
      database: async () => mockDatabasePlugin,
      storage: async () => mockStoragePlugin,
    });
  });

  it("creates a manual patch artifact and prints a summary", async () => {
    await createPatch({
      baseBundleId: "base-bundle",
      bundleId: "target-bundle",
      channel: "production",
      interactive: false,
      platform: "ios",
    });

    expect(mockCli.loadConfig).toHaveBeenCalledWith({
      channel: "production",
      platform: "ios",
    });
    expect(mockCli.p.note).toHaveBeenCalledWith(
      "Channel: production\nPlatform: iOS\nBase bundle: base-bundle\nTarget bundle: target-bundle",
      "Patch",
    );
    expect(mockServer.createBundleDiff).toHaveBeenCalledWith(
      {
        baseBundleId: "base-bundle",
        bundleId: "target-bundle",
      },
      {
        databasePlugin: mockDatabasePlugin,
        storagePlugin: mockStoragePlugin,
      },
      {
        makePrimary: true,
      },
    );
    expect(mockCli.p.outro).toHaveBeenCalledWith(
      "⚡ Patch Ready (target-bundle)",
    );
    expect(mockDatabasePlugin.close).toHaveBeenCalledOnce();
  });

  it("closes the database before exiting when storage acquisition fails", async () => {
    mockCli.loadConfig.mockResolvedValue({
      database: async () => mockDatabasePlugin,
      storage: async () => {
        throw new Error("storage unavailable");
      },
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      expect(mockCli.disposeLoadedDatabase).toHaveBeenCalledWith(
        mockDatabasePlugin,
      );
      expect(mockDatabasePlugin.close).toHaveBeenCalledOnce();
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      createPatch({
        baseBundleId: "base-bundle",
        bundleId: "target-bundle",
        channel: "production",
        interactive: false,
        platform: "ios",
      }),
    ).rejects.toThrow("process.exit(1)");
  });
});
