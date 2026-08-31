import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";
import type { DeployReleasePolicy } from "./deployTransaction";

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

const releasePolicy = (): DeployReleasePolicy => ({
  channel: "production",
  enabled: true,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion: "1.0.x",
  rolloutCohortCount: 1_000,
  targetCohorts: [],
});

const deployment = (bundle: Bundle) => ({ bundle, release: releasePolicy() });

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

describe("Bundle commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({ database: databaseHarness.plugin });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists separate console IDs for promotions sharing a file", async () => {
    const bundle = artifact("00000000-0000-7000-8000-000000000001");
    const androidBundle = artifact("android-file", "android");
    databaseHarness.setBundles([bundle, androidBundle]);
    for (const name of ["production", "staging"]) {
      await databaseHarness.plugin.models.channels.insert({
        row: { id: `channel-${name}`, name },
        onConflict: "returnExisting",
      });
    }
    const source = releaseReference(
      "00000000-0000-7000-8000-000000000002",
      bundle.id,
    );
    const promoted = {
      ...source,
      id: "00000000-0000-7000-8000-000000000003",
      channel_id: "channel-staging",
      operation: "PROMOTE" as const,
      source_release_id: source.id,
    };
    const android = {
      ...source,
      id: "00000000-0000-7000-8000-000000000004",
      bundle_id: androidBundle.id,
      platform: "android" as const,
    };
    await databaseHarness.plugin.commit({
      changes: [source, promoted, android].map((row) => ({
        model: "releases",
        operation: "insert",
        row,
      })),
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleBundleList, handleBundleShow } = await import("./bundle");

    await handleBundleList({ platform: "ios", limit: 5 });

    const table = String(output.mock.calls.at(-1)?.[0]);
    expect(table).toContain(source.id);
    expect(table).toContain(promoted.id);
    expect(table).not.toContain(bundle.id);
    expect(table).not.toContain(android.id);
    expect(table).not.toContain("Release ID");
    expect(table).not.toContain("Bundle / Embedded");

    await handleBundleList({ json: true, platform: "ios", limit: 5 });
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual([
      expect.objectContaining({ id: promoted.id, bundle_id: bundle.id }),
      expect.objectContaining({ id: source.id, bundle_id: bundle.id }),
    ]);

    await handleBundleShow(promoted.id);
    const summary = String(output.mock.calls.at(-1)?.[0]);
    expect(summary).toContain(`ID:`);
    expect(summary).toContain(promoted.id);
    expect(summary).toContain("staging");
    expect(summary).not.toContain(bundle.id);

    await handleBundleShow(promoted.id, { json: true });
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      id: promoted.id,
      bundle_id: bundle.id,
      source_release_id: source.id,
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
    const { handleBundleDelete } = await import("./bundle");

    await expect(handleBundleDelete([bundleId], { yes: true })).rejects.toThrow(
      releases[1_000]!.id,
    );

    expect(findMany).toHaveBeenCalledTimes(2);
    await expect(
      databaseHarness.plugin.models.bundles.findById(bundleId),
    ).resolves.not.toBeNull();
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
    await databaseHarness.seedDeployments([deployment(artifact(bundleId))]);
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
