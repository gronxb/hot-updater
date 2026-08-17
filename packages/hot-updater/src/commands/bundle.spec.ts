import type { LegacyBundle } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";

const { loadConfig, log } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig,
  p: {
    confirm: vi.fn(),
    isCancel: vi.fn(() => false),
    log,
  },
}));

vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));

const databaseHarness = createDatabasePluginHarness();

const artifact = (
  id: string,
  platform: LegacyBundle["platform"] = "ios",
): LegacyBundle => ({
  id,
  platform,
  fileHash: `hash-${id}`,
  storageUri: `storage://artifacts/${id}.zip`,
  gitCommitHash: "1234567890abcdef",
  channel: "production",
  enabled: true,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion: "1.0.x",
  rolloutCohortCount: 1_000,
  targetCohorts: [],
});

describe("Bundle artifact commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({ database: databaseHarness.plugin });
  });

  it("lists immutable artifact fields with a platform-only query", async () => {
    databaseHarness.setBundles([
      artifact("B2", "android"),
      artifact("B1", "ios"),
    ]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleBundleList } = await import("./bundle");

    await handleBundleList({ json: true, limit: 5, platform: "ios" });

    const payload = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(payload.data).toEqual([
      expect.objectContaining({
        id: "B1",
        platform: "ios",
        fileHash: "hash-B1",
        storageUri: "storage://artifacts/B1.zip",
      }),
    ]);
    expect(payload.data[0]).not.toHaveProperty("channel");
    expect(payload.data[0]).not.toHaveProperty("enabled");
  });

  it("shows artifact hashes, storage, and patch count without policy", async () => {
    databaseHarness.setBundles([artifact("B1")]);
    const { handleBundleShow } = await import("./bundle");

    await handleBundleShow("B1");

    expect(log.message).toHaveBeenCalledWith(expect.stringContaining("B1"));
    expect(log.message).toHaveBeenCalledWith(
      expect.stringContaining("storage://artifacts/B1.zip"),
    );
    expect(log.message).not.toHaveBeenCalledWith(
      expect.stringContaining("Channel"),
    );
  });

  it("deletes an unreferenced artifact", async () => {
    databaseHarness.setBundles([artifact("B1")]);
    const { handleBundleDelete } = await import("./bundle");

    await handleBundleDelete(["B1"], { yes: true });

    await expect(
      databaseHarness.plugin.models.bundles.findById("B1"),
    ).resolves.toBeNull();
    expect(log.success).toHaveBeenCalledWith("Deleted bundle record.");
  });

  it("preserves an artifact referenced by a Release", async () => {
    const bundleId = "00000000-0000-7000-8000-000000000001";
    await databaseHarness.seedLegacyBundles([artifact(bundleId)]);
    const { handleBundleDelete } = await import("./bundle");

    await expect(handleBundleDelete([bundleId], { yes: true })).rejects.toThrow(
      /referenced/i,
    );
    await expect(
      databaseHarness.plugin.models.bundles.findById(bundleId),
    ).resolves.not.toBeNull();
  });
});
