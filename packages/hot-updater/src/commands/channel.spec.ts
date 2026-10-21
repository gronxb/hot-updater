import type { Bundle } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testServer } from "../utils/testServer";
import { createDatabaseHarness } from "./database.testFixtures";
import {
  commitDeployment,
  type DeployReleasePolicy,
} from "./deployTransaction";

const { confirm, loadConfig, loadServer, log } = vi.hoisted(() => ({
  confirm: vi.fn(),
  loadConfig: vi.fn(),
  loadServer: vi.fn(),
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

vi.mock("@/utils/loadServer", async () => ({
  ...(await vi.importActual<typeof import("../utils/loadServer")>(
    "../utils/loadServer",
  )),
  loadServer,
}));

vi.mock("@/utils/expoDetection", () => ({ warnIfExpoCNG: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ setChannel: vi.fn() }));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

const databaseHarness = createDatabaseHarness();

const bundle = (suffix: string, platform: Bundle["platform"]): Bundle => ({
  assetBaseStorageUri: "storage://assets",
  id: `01900000-0000-7000-8000-00000000000${suffix}`,
  platform,
  gitCommitHash: null,
  manifestFileHash: `manifest-hash-${suffix}`,
  manifestStorageUri: `storage://artifacts/${suffix}/manifest.json`,
});

const policy = (channel: string): DeployReleasePolicy => ({
  channel,
  enabled: true,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion: "1.0.x",
});

const deploy = async (suffix: string, channel: string, platform = "ios") =>
  (
    await commitDeployment({
      core: databaseHarness.core,
      bundle: bundle(suffix, platform as Bundle["platform"]),
      release: policy(channel),
    })
  ).release!;

const output = () =>
  JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));

describe("handleChannelDelete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({});
    loadServer.mockResolvedValue(
      testServer({ database: databaseHarness.database }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("deletes a channel's bundles on both platforms, then the channel", async () => {
    await deploy("1", "pr-12");
    await deploy("2", "pr-12", "android");
    const kept = await deploy("3", "production");
    const { handleChannelDelete } = await import("./channel");

    await handleChannelDelete("pr-12", { json: true, yes: true });

    // The config's database and storage may read credentials from the vault.
    expect(loadConfig).toHaveBeenCalledWith(null, { credentials: true });

    expect(output()).toMatchObject({
      channel: "pr-12",
      deleted: true,
    });
    expect(output().deletedBundleIds).toHaveLength(2);
    await expect(
      databaseHarness.core.findChannelByName("pr-12"),
    ).resolves.toBeNull();
    expect(await databaseHarness.releases()).toEqual([
      expect.objectContaining({ id: kept.id }),
    ]);
    expect(await databaseHarness.bundles()).toEqual([
      expect.objectContaining({ id: bundle("3", "ios").id }),
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps the files of a bundle promoted to another channel", async () => {
    const release = await deploy("1", "pr-12");
    await databaseHarness.core.promoteRelease({
      releaseId: release.id,
      targetChannel: "production",
    });
    const { handleChannelDelete } = await import("./channel");

    await handleChannelDelete("pr-12", { json: true, yes: true });

    expect(output()).toMatchObject({ deleted: true });
    expect(await databaseHarness.bundles()).toEqual([
      expect.objectContaining({ id: bundle("1", "ios").id }),
    ]);
  });

  it("succeeds without a change when the channel is missing", async () => {
    const { handleChannelDelete } = await import("./channel");

    await handleChannelDelete("pr-12", { json: true, yes: true });

    expect(output()).toEqual({
      channel: "pr-12",
      deleted: false,
      reason: "not_found",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("deletes the bundles but keeps a channel a native build embeds, and fails", async () => {
    await deploy("1", "pr-12");
    await databaseHarness.core.registerNativeBuild({
      id: "01900000-0000-7000-8000-000000000101",
      platform: "ios",
      channel: "pr-12",
      fingerprintHash: "fingerprint",
      appVersion: null,
      minBundleId: "01900000-0000-7000-8000-000000000100",
      gitCommitHash: null,
      artifact: {
        kind: "app",
        storageUri: "storage://native-builds/ios/101/App.app.zip",
        byteSize: 10,
      },
      embeddedBundle: {
        manifestStorageUri: "storage://artifacts/100/manifest.json",
        manifestFileHash: "manifest-hash-100",
        assetBaseStorageUri: "storage://assets",
      },
    });
    const { handleChannelDelete } = await import("./channel");

    await handleChannelDelete("pr-12", { json: true, yes: true });

    expect(output()).toMatchObject({
      deleted: false,
      reason: "not_empty",
      deletedBundleIds: [expect.any(String)],
    });
    expect(await databaseHarness.releases()).toEqual([]);
    await expect(
      databaseHarness.core.findChannelByName("pr-12"),
    ).resolves.not.toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("a native build embeds it"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("asks before deleting in a terminal", async () => {
    await deploy("1", "pr-12");
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    confirm.mockResolvedValueOnce(true);
    const { handleChannelDelete } = await import("./channel");

    try {
      await handleChannelDelete("pr-12", { json: true });
    } finally {
      if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY);
    }

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Delete the pr-12 channel and its 1 bundle?",
      }),
    );
    expect(output()).toMatchObject({ deleted: true });
  });
});
