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

const bundle = (id: string, enabled = true): LegacyBundle => ({
  id,
  platform: "ios",
  fileHash: `hash-${id}`,
  storageUri: `storage://artifacts/${id}.zip`,
  gitCommitHash: null,
  channel: "production",
  enabled,
  fingerprintHash: null,
  message: id,
  shouldForceUpdate: false,
  targetAppVersion: "1.0.x",
  rolloutCohortCount: 1_000,
  targetCohorts: [],
});

const first = bundle("01900000-0000-7000-8000-000000000001");
const second = bundle("01900000-0000-7000-8000-000000000002");

const latestRelease = async () => {
  const channel = (
    await databaseHarness.plugin.models.channels.list({})
  ).channels.find(({ name }) => name === "production")!;
  return (
    await databaseHarness.plugin.models.releases.findMany({
      channelId: channel.id,
      limit: 100,
      platform: "ios",
    })
  )[0];
};

describe("handleRollback", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    databaseHarness.reset();
    await databaseHarness.seedLegacyBundles([first, second]);
    loadConfig.mockResolvedValue({ database: databaseHarness.plugin });
  });

  it("uses --to-release as an unambiguous target", async () => {
    const { handleRollback } = await import("./rollback");

    await handleRollback("production", {
      platform: "ios",
      toRelease: first.id,
      yes: true,
    });

    expect(await latestRelease()).toMatchObject({
      bundle_id: first.id,
      operation: "ROLLBACK",
      should_force_update: true,
      rollout_cohort_count: 1_000,
      source_release_id: first.id,
    });
  });

  it("creates a newer EMBEDDED Release explicitly", async () => {
    const { handleRollback } = await import("./rollback");

    await handleRollback("production", {
      embedded: true,
      platform: "ios",
      yes: true,
    });

    expect(await latestRelease()).toMatchObject({
      bundle_id: null,
      kind: "EMBEDDED",
      operation: "ROLLBACK",
    });
  });

  it("a repeated rollback moves farther back instead of bouncing forward", async () => {
    const third = bundle("01900000-0000-7000-8000-000000000003");
    databaseHarness.reset();
    await databaseHarness.seedLegacyBundles([first, second, third]);
    const { handleRollback } = await import("./rollback");

    await handleRollback("production", { platform: "ios", yes: true });
    const firstRollback = await latestRelease();
    expect(firstRollback?.bundle_id).toBe(second.id);

    await handleRollback("production", { platform: "ios", yes: true });
    expect(await latestRelease()).toMatchObject({
      bundle_id: first.id,
      operation: "ROLLBACK",
    });
  });

  it("rejects mutually ambiguous rollback targets before mutating", async () => {
    const { handleRollback } = await import("./rollback");

    await expect(
      handleRollback("production", {
        embedded: true,
        toRelease: first.id,
        yes: true,
      }),
    ).rejects.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      "Choose only one of --to-release, --to-bundle, or --embedded.",
    );
    expect(databaseHarness.commit).not.toHaveBeenCalled();
  });
});
