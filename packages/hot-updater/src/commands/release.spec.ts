import type { LegacyBundle } from "@hot-updater/plugin-core";
import { updateReleasePolicy } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";

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

vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

const databaseHarness = createDatabasePluginHarness();
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

const releaseBundle = (
  id: string,
  overrides: Partial<LegacyBundle> = {},
): LegacyBundle => ({
  channel: "production",
  enabled: true,
  fileHash: `hash-${id}`,
  fingerprintHash: null,
  gitCommitHash: null,
  id,
  message: "ready",
  platform: "ios",
  rolloutCohortCount: 500,
  shouldForceUpdate: true,
  storageUri: `storage://artifacts/${id}.zip`,
  targetAppVersion: "1.0.x",
  targetCohorts: ["staff"],
  ...overrides,
});

describe("Release commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({ database: databaseHarness.plugin });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    }
  });

  it("filters Releases by Bundle and includes creation time in the table", async () => {
    const first = releaseBundle("01900000-0000-7000-8000-000000000001");
    const second = releaseBundle("01900000-0000-7000-8000-000000000002");
    await databaseHarness.seedLegacyBundles([first, second]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleReleaseList } = await import("./release");

    await handleReleaseList({ bundleId: first.id });

    const rendered = String(output.mock.calls[0]?.[0]);
    expect(rendered).toContain("Created");
    expect(rendered).toContain(first.id);
    expect(rendered).not.toContain(second.id);
  });

  it("shows complete Release policy, scope, and provenance", async () => {
    const bundle = releaseBundle("01900000-0000-7000-8000-000000000001");
    await databaseHarness.seedLegacyBundles([bundle]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleReleaseShow } = await import("./release");

    await handleReleaseShow(bundle.id);

    const rendered = String(output.mock.calls[0]?.[0]);
    for (const field of [
      "Scope",
      "Strategy",
      "Target cohorts",
      "Source Release",
      "Created",
      "Updated",
    ]) {
      expect(rendered).toContain(field);
    }
    expect(rendered).toContain("staff");
    expect(rendered).toContain("APP_VERSION");
  });

  it("previews device-dependent fallback and warns for the sole enabled Release", async () => {
    const bundle = releaseBundle("01900000-0000-7000-8000-000000000001");
    await databaseHarness.seedLegacyBundles([bundle]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleReleaseEnablement } = await import("./release");

    await handleReleaseEnablement(bundle.id, false, { yes: true });

    expect(log.message).toHaveBeenCalledWith(
      expect.stringContaining("previous compatible enabled Release or BUILTIN"),
    );
    expect(log.message).toHaveBeenCalledWith(
      expect.stringContaining("device-dependent"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("only enabled Release"),
    );
    await expect(
      databaseHarness.plugin.models.releases.findById(bundle.id),
    ).resolves.toMatchObject({ enabled: false, revision: 2 });
  });

  it("uses the previewed revision as the disable CAS boundary", async () => {
    const bundle = releaseBundle("01900000-0000-7000-8000-000000000001");
    await databaseHarness.seedLegacyBundles([bundle]);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    confirm.mockImplementationOnce(async () => {
      await updateReleasePolicy({
        database: databaseHarness.plugin,
        patch: { message: "changed concurrently" },
        releaseId: bundle.id,
      });
      return true;
    });
    const { handleReleaseEnablement } = await import("./release");

    await expect(handleReleaseEnablement(bundle.id, false, {})).rejects.toThrow(
      /revision/i,
    );

    await expect(
      databaseHarness.plugin.models.releases.findById(bundle.id),
    ).resolves.toMatchObject({
      enabled: true,
      message: "changed concurrently",
      revision: 2,
    });
  });

  it("keeps JSON disable output machine-readable without a human preview", async () => {
    const bundle = releaseBundle("01900000-0000-7000-8000-000000000001");
    await databaseHarness.seedLegacyBundles([bundle]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleReleaseEnablement } = await import("./release");

    await handleReleaseEnablement(bundle.id, false, {
      json: true,
      yes: true,
    });

    const payload = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(payload.release).toMatchObject({
      enabled: false,
      id: bundle.id,
      revision: 2,
    });
    expect(payload.catalog).toEqual(
      expect.objectContaining({ scope_key: expect.any(String) }),
    );
    expect(log.message).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
