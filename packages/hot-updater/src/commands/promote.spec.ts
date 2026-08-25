import type { Bundle } from "@hot-updater/plugin-core";
import { updateReleasePolicy } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";
import type { DeployReleasePolicy } from "./deployTransaction";

const { confirm, loadConfig, log } = vi.hoisted(() => ({
  confirm: vi.fn(),
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
    confirm,
    isCancel: vi.fn(() => false),
    log,
  },
}));

vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));

const databaseHarness = createDatabasePluginHarness();
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

const sourceBundle: Bundle = {
  archiveByteSize: 1024,
  id: "01900000-0000-7000-8000-000000000001",
  platform: "ios",
  fileHash: "hash-B1",
  storageUri: "storage://artifacts/B1.zip",
  gitCommitHash: null,
};
const sourceRelease: DeployReleasePolicy = {
  channel: "production",
  enabled: true,
  fingerprintHash: null,
  message: "ready",
  shouldForceUpdate: false,
  targetAppVersion: "1.0.x",
  rolloutCohortCount: 250,
  targetCohorts: ["staff"],
};

const releasesForChannel = async (name: string) => {
  const channel = (
    await databaseHarness.plugin.models.channels.list({})
  ).channels.find((row) => row.name === name);
  if (channel === undefined) return [];
  return databaseHarness.plugin.models.releases.findMany({
    channelId: channel.id,
    limit: 100,
  });
};

describe("handlePromote", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    databaseHarness.reset();
    await databaseHarness.seedDeployments([
      { bundle: sourceBundle, release: sourceRelease },
    ]);
    loadConfig.mockResolvedValue({ database: databaseHarness.plugin });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    }
  });

  it("creates a target-channel Release that reuses the source Bundle", async () => {
    const { handlePromote } = await import("./promote");

    await handlePromote(sourceBundle.id, {
      action: "copy",
      target: "beta",
      yes: true,
    });

    const promoted = (await releasesForChannel("beta"))[0];
    expect(promoted).toMatchObject({
      bundle_id: sourceBundle.id,
      operation: "PROMOTE",
      source_release_id: sourceBundle.id,
      rollout_cohort_count: 1_000,
      target_cohorts: [],
    });
    expect(await databaseHarness.bundles()).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("reused"));
    const preview = String(log.message.mock.calls[0]?.[0]);
    expect(preview).toContain("Target enabled");
    expect(preview).toContain("100%");
    expect(preview).toContain("(none)");
    expect(preview).toContain("new Release ID");
    expect(preview).toContain("remains unchanged");
  });

  it("atomically disables the source Release for move promotion", async () => {
    const { handlePromote } = await import("./promote");

    await handlePromote(sourceBundle.id, {
      action: "move",
      target: "beta",
      yes: true,
    });

    await expect(
      databaseHarness.plugin.models.releases.findById(sourceBundle.id),
    ).resolves.toMatchObject({ enabled: false, revision: 2 });
    expect((await releasesForChannel("beta"))[0]).toMatchObject({
      enabled: true,
      operation: "PROMOTE",
    });
    expect(databaseHarness.commit).toHaveBeenCalledTimes(1);
    expect(String(log.message.mock.calls[0]?.[0])).toContain(
      "disabled atomically",
    );
  });

  it("rejects promotion when the previewed source revision changes", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    confirm.mockImplementationOnce(async () => {
      await updateReleasePolicy({
        database: databaseHarness.plugin,
        patch: { message: "changed concurrently" },
        releaseId: sourceBundle.id,
      });
      return true;
    });
    const { handlePromote } = await import("./promote");

    await expect(
      handlePromote(sourceBundle.id, { target: "beta" }),
    ).rejects.toThrow(/revision/i);

    expect(await releasesForChannel("beta")).toEqual([]);
    await expect(
      databaseHarness.plugin.models.releases.findById(sourceBundle.id),
    ).resolves.toMatchObject({
      enabled: true,
      message: "changed concurrently",
      revision: 2,
    });
  });

  it("rejects a promotion back into the same Release scope", async () => {
    const { handlePromote } = await import("./promote");

    await expect(
      handlePromote(sourceBundle.id, {
        target: "production",
        yes: true,
      }),
    ).rejects.toThrow(/same/i);
  });
});
