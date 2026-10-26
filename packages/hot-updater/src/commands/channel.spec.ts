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

    expect(loadConfig).toHaveBeenCalledWith(null);

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
      buildKey: null,
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
    // stdout stays one JSON document, which says why.
    expect(log.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await handleChannelDelete("pr-12", { yes: true });
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

describe("handleChannelLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const printed = () =>
    vi
      .mocked(console.log)
      .mock.calls.map(([line]) => String(line))
      .join("\n");

  it("prints the link console.channelLinkPrefix makes, as JSON", async () => {
    loadConfig.mockResolvedValue({
      console: { channelLinkPrefix: "https://example.com/app" },
    });
    const { handleChannelLink } = await import("./channel");

    await handleChannelLink("pr-12", { json: true });

    expect(output()).toEqual({
      channel: "pr-12",
      link: "https://example.com/app/hot-updater/channel/pr-12",
    });
    expect(loadServer).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a null link without a prefix under --json, and succeeds", async () => {
    loadConfig.mockResolvedValue({});
    const { handleChannelLink } = await import("./channel");

    await handleChannelLink("pr-12", { json: true });

    expect(output()).toEqual({ channel: "pr-12", link: null });
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the link with the commands that open it on an emulator or simulator", async () => {
    loadConfig.mockResolvedValue({
      console: { channelLinkPrefix: "myapp://" },
    });
    const { handleChannelLink } = await import("./channel");

    await handleChannelLink("pr-12", {});

    const text = printed();
    expect(text).toContain("myapp://hot-updater/channel/pr-12");
    expect(text).toContain(
      "adb shell am start -a android.intent.action.VIEW -d myapp://hot-updater/channel/pr-12",
    );
    expect(text).toContain(
      "xcrun simctl openurl booted myapp://hot-updater/channel/pr-12",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("quotes a link the shell would read otherwise", async () => {
    loadConfig.mockResolvedValue({
      console: { channelLinkPrefix: "https://example.com/?app=1&x=" },
    });
    const { handleChannelLink } = await import("./channel");

    await handleChannelLink("pr-12", {});

    const text = printed();
    // adb shell parses the link again on the device, so it's quoted twice.
    expect(text).toContain(
      String.raw`-d ''\''https://example.com/?app=1&x=/hot-updater/channel/pr-12'\'''`,
    );
    expect(text).toContain(
      "xcrun simctl openurl booted 'https://example.com/?app=1&x=/hot-updater/channel/pr-12'",
    );
  });

  it("fails without a prefix, naming the option", async () => {
    loadConfig.mockResolvedValue({});
    const { handleChannelLink } = await import("./channel");

    await handleChannelLink("pr-12", {});

    expect(console.log).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("console.channelLinkPrefix"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("fails for a name that is not a channel name", async () => {
    loadConfig.mockResolvedValue({
      console: { channelLinkPrefix: "myapp://" },
    });
    const { handleChannelLink } = await import("./channel");

    await handleChannelLink(" pr-12", { json: true });

    expect(console.log).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('" pr-12" is not a channel name.');
    expect(process.exitCode).toBe(1);
  });
});

// The terminal these specs simulate takes prompts only outside CI, and CI
// runners set CI.
beforeEach(() => {
  vi.stubEnv("CI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});
