import { stripVTControlCharacters } from "node:util";

import type { Bundle } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabaseHarness } from "./database.testFixtures";

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

const databaseHarness = createDatabaseHarness();

const artifact = (
  id: string,
  platform: Bundle["platform"] = "ios",
): Bundle => ({
  assetBaseStorageUri: "storage://assets",
  id,
  platform,
  gitCommitHash: "1234567890abcdef",
  manifestFileHash: `manifest-hash-${id}`,
  manifestStorageUri: `storage://artifacts/${id}/manifest.json`,
});

const policy = (channel: string, targetAppVersion = "1.0.x") => ({
  channel,
  enabled: true,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion,
});

describe("Bundle commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({ database: databaseHarness.database });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists separate console IDs for promotions sharing a file", async () => {
    const bundle = artifact("00000000-0000-7000-8000-000000000001");
    const androidBundle = artifact("android-file", "android");
    const { core } = databaseHarness;
    const [deployed] = await core.deploy([
      { bundle, release: policy("production") },
    ]);
    const source = deployed!.release!;
    const promoted = (
      await core.promoteRelease({
        releaseId: source.id,
        targetChannel: "staging",
      })
    ).target.release!;
    const [androidDeployed] = await core.deploy([
      { bundle: androidBundle, release: policy("production") },
    ]);
    const android = androidDeployed!.release!;
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleBundleList, handleBundleShow } = await import("./bundle");

    await handleBundleList({ platform: "ios", limit: 5 });

    const table = stripVTControlCharacters(
      String(output.mock.calls.at(-1)?.[0]),
    );
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
    const summary = stripVTControlCharacters(
      String(output.mock.calls.at(-1)?.[0]),
    );
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

  it("combines the v0 channel and target app version filters", async () => {
    const bundle = artifact("00000000-0000-7000-8000-000000000011");
    const { core } = databaseHarness;
    const releaseOf = async (
      deployment: Parameters<typeof core.deploy>[0][number],
    ) => (await core.deploy([deployment]))[0]!.release!;
    const matching = await releaseOf({
      bundle,
      release: policy("production"),
    });
    const otherVersion = await releaseOf({
      bundleId: bundle.id,
      release: policy("production", "2.0.x"),
    });
    const otherChannel = await releaseOf({
      bundleId: bundle.id,
      release: policy("staging"),
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleBundleList } = await import("./bundle");

    await handleBundleList({
      channel: "production",
      targetAppVersion: "1.0.x",
      limit: 5,
    });

    const table = stripVTControlCharacters(
      String(output.mock.calls.at(-1)?.[0]),
    );
    expect(table).toContain(matching.id);
    expect(table).not.toContain(otherVersion.id);
    expect(table).not.toContain(otherChannel.id);
  });

  it("translates internal release mutation errors at the public boundary", async () => {
    const { handleBundleUpdate } = await import("./bundle");

    await expect(
      handleBundleUpdate("00000000-0000-7000-8000-000000000099", {
        message: "updated",
        yes: true,
      }),
    ).rejects.toMatchObject({
      message: 'Bundle "00000000-0000-7000-8000-000000000099" was not found.',
      cause: expect.objectContaining({
        message:
          'Release "00000000-0000-7000-8000-000000000099" was not found.',
      }),
    });
  });
});
