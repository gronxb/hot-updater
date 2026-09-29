import { stripVTControlCharacters } from "node:util";

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

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: mockCli.loadConfig,
  p: mockCli.p,
}));

vi.mock("@hot-updater/server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/server/db")>()),
  createBundleDiff: mockServer.createBundleDiff,
}));

vi.mock("@/prompts/getPlatform", () => ({
  getPlatform: vi.fn(),
}));

vi.mock("@/utils/printBanner", () => ({
  printBanner: vi.fn(),
}));

import { createDatabaseHarness } from "./database.testFixtures";
import { createPatch } from "./patch";

const databaseHarness = createDatabaseHarness();

describe("createPatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();

    mockCli.p.isCancel.mockReturnValue(false);
    mockServer.createBundleDiff.mockResolvedValue({
      id: "target-bundle",
    });
    mockCli.loadConfig.mockResolvedValue({
      database: databaseHarness.database,
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
    const [rendered, title] = mockCli.p.note.mock.calls[0]!;
    const summary = stripVTControlCharacters(String(rendered));
    expect(title).toBe("Patch");
    expect(summary).toMatch(/Channel:\s+production/);
    expect(summary).toMatch(/Platform:\s+ios/);
    expect(summary).toMatch(/Base artifact ID:\s+base-bundle/);
    expect(summary).toMatch(/Target artifact ID:\s+target-bundle/);
    expect(mockServer.createBundleDiff).toHaveBeenCalledWith(
      {
        baseBundleId: "base-bundle",
        bundleId: "target-bundle",
      },
      {
        database: databaseHarness.database,
        storagePlugin: mockStoragePlugin,
      },
      {
        makePrimary: true,
      },
    );
    expect(mockCli.p.outro).toHaveBeenCalledWith("Patch ready.");
    expect(databaseHarness.dispose).toHaveBeenCalledOnce();
  });
});
