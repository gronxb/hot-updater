import { stripVTControlCharacters } from "node:util";

import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
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

vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

const databaseHarness = createDatabasePluginHarness();

const artifact = (
  id: string,
  platform: Bundle["platform"] = "ios",
): Bundle => ({
  archiveByteSize: 1024,
  id,
  platform,
  fileHash: `hash-${id}`,
  storageUri: `storage://artifacts/${id}.zip`,
  gitCommitHash: "1234567890abcdef",
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

describe("Artifact commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({ database: databaseHarness.plugin });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    const { handleArtifactDelete } = await import("./artifact");

    await expect(
      handleArtifactDelete([bundleId], { yes: true }),
    ).rejects.toThrow(releases[1_000]!.id);

    expect(findMany).toHaveBeenCalledTimes(2);
    await expect(
      databaseHarness.plugin.models.bundles.findById(bundleId),
    ).resolves.not.toBeNull();
  });

  it("deletes an unreferenced artifact", async () => {
    databaseHarness.setBundles([artifact("B1")]);
    const { handleArtifactDelete } = await import("./artifact");

    await handleArtifactDelete(["B1"], { yes: true });

    await expect(
      databaseHarness.plugin.models.bundles.findById("B1"),
    ).resolves.toBeNull();
    expect(log.success).toHaveBeenCalledWith("Deleted artifact record.");
    expect(
      log.info.mock.calls.map(([message]) =>
        stripVTControlCharacters(String(message)),
      ),
    ).toContainEqual(expect.stringMatching(/Artifact ID:\s+B1/));
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("storage prune --dry-run"),
    );
  });

  it("preserves an artifact referenced by a Release", async () => {
    const bundleId = "00000000-0000-7000-8000-000000000001";
    databaseHarness.setBundles([artifact(bundleId)]);
    await databaseHarness.plugin.models.channels.insert({
      row: { id: "channel-production", name: "production" },
      onConflict: "returnExisting",
    });
    const release = releaseReference(
      "00000000-0000-7000-8000-000000000002",
      bundleId,
    );
    await databaseHarness.plugin.commit({
      changes: [{ model: "releases", operation: "insert", row: release }],
    });
    databaseHarness.commit.mockClear();
    const { handleArtifactDelete } = await import("./artifact");

    await expect(
      handleArtifactDelete([bundleId], { yes: true }),
    ).rejects.toThrow(
      `Cannot delete artifacts referenced by bundles. Disable and delete these bundles first:\nArtifact ID ${bundleId}: referenced by bundle IDs ${release.id}`,
    );
    expect(databaseHarness.commit).not.toHaveBeenCalled();
    await expect(
      databaseHarness.plugin.models.bundles.findById(bundleId),
    ).resolves.not.toBeNull();
  });
});
