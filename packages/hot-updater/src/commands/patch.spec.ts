import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockServer, mockStoragePlugin } = vi.hoisted(() => {
  const mockStoragePlugin = {
    delete: vi.fn(),
    get: vi.fn(),
    name: "mock-storage",
    protocol: "s3",
    put: vi.fn(),
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

describe("createPatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();

    mockCli.p.isCancel.mockReturnValue(false);
    mockServer.createBundleDiff.mockResolvedValue({
      id: "target-bundle",
    });
    mockCli.loadConfig.mockResolvedValue({
      database: databaseHarness.plugin,
      storage: mockStoragePlugin,
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
    expect(databaseHarness.dispose).toHaveBeenCalledOnce();
  });
});
