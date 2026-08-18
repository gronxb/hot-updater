import type { LegacyBundle, ReleaseRow } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const releaseReference = (id: string, bundleId: string): ReleaseRow => ({
  bundle_id: bundleId,
  channel_id: "channel-production",
  created_at_ms: 1,
  enabled: true,
  fingerprint_hash: null,
  id,
  kind: "BUNDLE",
  message: null,
  operation: "DEPLOY",
  platform: "ios",
  revision: 1,
  rollout_cohort_count: 1_000,
  scope_key: "scope-production-ios",
  should_force_update: false,
  source_release_id: null,
  strategy: "APP_VERSION",
  target_app_version: "1.0.x",
  target_cohorts: [],
  updated_at_ms: 1,
});

describe("Bundle artifact commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({ database: databaseHarness.plugin });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(log.message).toHaveBeenCalledWith(
      expect.stringContaining("Release references"),
    );
  });

  it("shows referencing Release ids in human and JSON output", async () => {
    const bundleId = "00000000-0000-7000-8000-000000000001";
    await databaseHarness.seedLegacyBundles([artifact(bundleId)]);
    const existingRelease = (await databaseHarness.releases())[0]!;
    const secondRelease = {
      ...existingRelease,
      id: "00000000-0000-7000-8000-000000000002",
    };
    await databaseHarness.plugin.commit({
      changes: [{ model: "releases", operation: "insert", row: secondRelease }],
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleBundleShow } = await import("./bundle");

    await handleBundleShow(bundleId);

    const humanOutput = String(log.message.mock.calls[0]?.[0]);
    expect(humanOutput).toContain("Release references");
    expect(humanOutput).toContain("2");
    expect(humanOutput).toContain(existingRelease.id);
    expect(humanOutput).toContain(secondRelease.id);

    await handleBundleShow(bundleId, { json: true });

    const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    expect(payload.releaseReferences).toEqual({
      count: 2,
      ids: [secondRelease.id, existingRelease.id],
    });
  });

  it("paginates through all Release references", async () => {
    const bundleId = "B1";
    databaseHarness.setBundles([artifact(bundleId)]);
    const releases = Array.from({ length: 1_001 }, (_, index) =>
      releaseReference(
        `release-${String(1_001 - index).padStart(4, "0")}`,
        bundleId,
      ),
    );
    const findMany = vi
      .spyOn(databaseHarness.plugin.models.releases, "findMany")
      .mockImplementation(async (input) => {
        if (input.beforeReleaseId === undefined) {
          return releases.slice(0, 1_000);
        }
        expect(input.beforeReleaseId).toBe(releases[999]!.id);
        return releases.slice(1_000);
      });
    const { handleBundleShow } = await import("./bundle");

    await handleBundleShow(bundleId);

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(log.message).toHaveBeenCalledWith(expect.stringContaining("1001"));
    expect(log.message).toHaveBeenCalledWith(
      expect.stringContaining("(+996 more)"),
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
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("storage prune --dry-run"),
    );
  });

  it("preserves an artifact referenced by a Release", async () => {
    const bundleId = "00000000-0000-7000-8000-000000000001";
    await databaseHarness.seedLegacyBundles([artifact(bundleId)]);
    const [release] = await databaseHarness.releases();
    databaseHarness.commit.mockClear();
    const { handleBundleDelete } = await import("./bundle");

    await expect(handleBundleDelete([bundleId], { yes: true })).rejects.toThrow(
      `Cannot delete Bundle records referenced by Releases. Disable and delete these Releases first:\n${bundleId}: ${release!.id}`,
    );
    expect(databaseHarness.commit).not.toHaveBeenCalled();
    await expect(
      databaseHarness.plugin.models.bundles.findById(bundleId),
    ).resolves.not.toBeNull();
  });
});
