import type { NativeBuildRegistration } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testServer } from "../utils/testServer";
import { createDatabaseHarness } from "./database.testFixtures";

const {
  generateFingerprint,
  getChannel,
  loadConfig,
  loadServer,
  log,
  resolveNativeAppVersion,
} = vi.hoisted(() => ({
  generateFingerprint: vi.fn(),
  getChannel: vi.fn(),
  loadConfig: vi.fn(),
  loadServer: vi.fn(),
  log: { error: vi.fn() },
  resolveNativeAppVersion: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig,
  p: { log },
}));
vi.mock("../utils/loadServer", () => ({ loadServer }));
vi.mock("@/utils/loadServer", () => ({ loadServer }));
vi.mock("../utils/fingerprint", () => ({ generateFingerprint }));
vi.mock("../utils/setChannel", () => ({ getChannel }));
vi.mock("../utils/version/getNativeAppVersion", () => ({
  resolveNativeAppVersion,
}));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

const databaseHarness = createDatabaseHarness();

const register = (
  suffix: string,
  scope: Pick<
    NativeBuildRegistration,
    "platform" | "channel" | "fingerprintHash" | "appVersion"
  >,
) =>
  databaseHarness.core.registerNativeBuild({
    ...scope,
    id: `01900000-0000-7000-8000-00000000b00${suffix}`,
    minBundleId: `01900000-0000-7000-8000-00000000a00${suffix}`,
    gitCommitHash: null,
    buildKey: null,
    artifact: {
      kind: scope.platform === "android" ? "apk" : "app",
      storageUri: `storage://native-builds/${scope.platform}/b00${suffix}/artifact`,
      byteSize: 1_024,
    },
    embeddedBundle: {
      manifestStorageUri: `storage://artifacts/a00${suffix}/manifest.json`,
      manifestFileHash: `manifest-hash-${suffix}`,
      assetBaseStorageUri: `storage://artifacts/a00${suffix}/assets`,
    },
  } as NativeBuildRegistration);

const nativeBuild = {
  android: {
    releaseApk: { packageName: "com.example", variant: "Release", aab: false },
    releaseAab: { packageName: "com.example", variant: "Release" },
  },
  ios: {
    simulator: {
      scheme: "Example",
      bundleIdentifier: "com.example",
      configuration: "Release",
      simulator: true,
    },
    device: {
      scheme: "Example",
      bundleIdentifier: "com.example",
      configuration: "Release",
      exportOptionsPlist: "ExportOptions.plist",
    },
  },
};

const prebuild = vi.fn();
const getNativeProjectValues = vi.fn();
const build = vi.fn(async () => ({
  name: "test",
  nativeBuild: { prebuild },
}));

const output = () =>
  JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));

describe("handleNativeBuildFind", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({
      updateStrategy: "fingerprint",
      nativeBuild,
      build,
    });
    loadServer.mockResolvedValue(
      testServer({ database: databaseHarness.database }),
    );
    generateFingerprint.mockResolvedValue({ hash: "fingerprint-a" });
    getChannel.mockResolvedValue({ value: "preview", paths: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the build registered for the fingerprint the build would embed, on the native project's channel", async () => {
    await register("1", {
      platform: "android",
      channel: "preview",
      fingerprintHash: "fingerprint-a",
      appVersion: null,
    });
    loadConfig.mockImplementation(async (loadedFor: unknown) => ({
      updateStrategy: "fingerprint",
      nativeBuild,
      build,
      loadedFor,
    }));
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await handleNativeBuildFind({ platform: "android", json: true });

    // The scheme and target as the native build loads them, and the
    // registry as registration loads it.
    expect(loadConfig).toHaveBeenCalledWith({
      platform: "android",
      channel: "",
    });
    expect(loadConfig).toHaveBeenCalledWith(null);
    expect(loadServer).toHaveBeenCalledWith(
      expect.objectContaining({ loadedFor: null }),
    );
    expect(generateFingerprint).toHaveBeenCalledWith("android");
    expect(output()).toEqual({
      platform: "android",
      channel: "preview",
      fingerprintHash: "fingerprint-a",
      appVersion: null,
      nativeBuild: expect.objectContaining({
        id: "01900000-0000-7000-8000-00000000b001",
        min_bundle_id: "01900000-0000-7000-8000-00000000a001",
        artifact_kind: "apk",
      }),
    });
    expect(databaseHarness.database.dispose).toHaveBeenCalled();
  });

  it("prints the newest of a scope's builds", async () => {
    for (const suffix of ["1", "2"]) {
      await register(suffix, {
        platform: "android",
        channel: "preview",
        fingerprintHash: "fingerprint-a",
        appVersion: null,
      });
    }
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await handleNativeBuildFind({ platform: "android", json: true });

    expect(output().nativeBuild.id).toBe(
      "01900000-0000-7000-8000-00000000b002",
    );
  });

  it.each([
    [
      "another fingerprint",
      {
        platform: "android",
        channel: "preview",
        fingerprintHash: "fingerprint-b",
        appVersion: null,
      },
    ],
    [
      "another channel",
      {
        platform: "android",
        channel: "production",
        fingerprintHash: "fingerprint-a",
        appVersion: null,
      },
    ],
    [
      "another platform",
      {
        platform: "ios",
        channel: "preview",
        fingerprintHash: "fingerprint-a",
        appVersion: null,
      },
    ],
  ] as const)(
    "prints no build when the registered one has %s, and succeeds",
    async (_, scope) => {
      await register("1", scope);
      const { handleNativeBuildFind } = await import("./nativeBuild");

      await handleNativeBuildFind({ platform: "android", json: true });

      expect(output()).toEqual({
        platform: "android",
        channel: "preview",
        fingerprintHash: "fingerprint-a",
        appVersion: null,
        nativeBuild: null,
      });
      expect(process.exit).not.toHaveBeenCalled();
    },
  );

  it("looks on the channel --channel names instead of the native project's", async () => {
    await register("1", {
      platform: "android",
      channel: "preview",
      fingerprintHash: "fingerprint-a",
      appVersion: null,
    });
    getChannel.mockResolvedValue({ value: "production", paths: [] });
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await handleNativeBuildFind({
      platform: "android",
      channel: "preview",
      json: true,
    });

    expect(getChannel).not.toHaveBeenCalled();
    expect(output().nativeBuild.id).toBe(
      "01900000-0000-7000-8000-00000000b001",
    );
  });

  it("matches the version of the app the scheme builds with the appVersion strategy", async () => {
    loadConfig.mockResolvedValue({
      updateStrategy: "appVersion",
      nativeBuild,
      build,
    });
    resolveNativeAppVersion.mockResolvedValue({
      version: "2.1.0",
      candidates: [],
    });
    await register("1", {
      platform: "ios",
      channel: "preview",
      fingerprintHash: null,
      appVersion: "2.1.0",
    });
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await handleNativeBuildFind({
      platform: "ios",
      scheme: "simulator",
      json: true,
    });

    expect(resolveNativeAppVersion).toHaveBeenCalledWith(
      "ios",
      {
        ios: {
          scheme: "Example",
          bundleIdentifier: "com.example",
          configuration: "Release",
        },
        android: undefined,
      },
      undefined,
    );
    expect(generateFingerprint).not.toHaveBeenCalled();
    expect(output()).toEqual({
      platform: "ios",
      channel: "preview",
      fingerprintHash: null,
      appVersion: "2.1.0",
      nativeBuild: expect.objectContaining({
        id: "01900000-0000-7000-8000-00000000b001",
      }),
    });
  });

  it("reads the app version from the native project as it is, without the adapter's prebuild", async () => {
    loadConfig.mockResolvedValue({
      updateStrategy: "appVersion",
      nativeBuild,
      build,
    });
    resolveNativeAppVersion.mockResolvedValue({
      version: "2.1.0",
      candidates: [],
    });
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await handleNativeBuildFind({ platform: "ios", json: true });

    expect(prebuild).not.toHaveBeenCalled();
    expect(output()).toMatchObject({ channel: "preview", appVersion: "2.1.0" });
  });

  it("looks up what the adapter's prebuild would write, without running it", async () => {
    loadConfig.mockResolvedValue({
      updateStrategy: "appVersion",
      nativeBuild,
      build: async () => ({
        name: "test",
        nativeBuild: { prebuild, getNativeProjectValues },
      }),
    });
    getNativeProjectValues.mockResolvedValue({
      appVersion: "3.0.0",
      channel: "qa",
    });
    resolveNativeAppVersion.mockImplementation(
      async (_platform: unknown, _scope: unknown, baseVersion?: string) => ({
        version: baseVersion ?? null,
        candidates: [],
      }),
    );
    await register("1", {
      platform: "android",
      channel: "qa",
      fingerprintHash: null,
      appVersion: "3.0.0",
    });
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await handleNativeBuildFind({ platform: "android", json: true });

    expect(getNativeProjectValues).toHaveBeenCalledWith({
      platform: "android",
    });
    expect(prebuild).not.toHaveBeenCalled();
    // The native project still names a scheme's own version.
    expect(resolveNativeAppVersion).toHaveBeenCalledWith(
      "android",
      {},
      "3.0.0",
    );
    expect(getChannel).not.toHaveBeenCalled();
    expect(output()).toMatchObject({
      platform: "android",
      channel: "qa",
      appVersion: "3.0.0",
      nativeBuild: expect.objectContaining({
        id: "01900000-0000-7000-8000-00000000b001",
      }),
    });

    // --channel still names the channel to look on.
    await handleNativeBuildFind({
      platform: "android",
      channel: "preview",
      json: true,
    });
    expect(output()).toMatchObject({ channel: "preview", nativeBuild: null });
  });

  it("reads what the adapter can't tell from the native project", async () => {
    loadConfig.mockResolvedValue({
      updateStrategy: "appVersion",
      nativeBuild,
      build: async () => ({
        name: "test",
        nativeBuild: { prebuild, getNativeProjectValues },
      }),
    });
    getNativeProjectValues.mockResolvedValue({});
    resolveNativeAppVersion.mockResolvedValue({
      version: "2.1.0",
      candidates: [],
    });
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await handleNativeBuildFind({ platform: "ios", json: true });

    expect(prebuild).not.toHaveBeenCalled();
    expect(output()).toMatchObject({ channel: "preview", appVersion: "2.1.0" });
  });

  it("runs the prebuild, saying so, only when no native project declares a version", async () => {
    loadConfig.mockResolvedValue({
      updateStrategy: "appVersion",
      nativeBuild,
      build,
    });
    resolveNativeAppVersion
      .mockResolvedValueOnce({ version: null, candidates: [] })
      .mockResolvedValueOnce({ version: "2.1.0", candidates: [] });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await handleNativeBuildFind({ platform: "ios", channel: "qa", json: true });

    expect(prebuild).toHaveBeenCalledTimes(1);
    expect(prebuild).toHaveBeenCalledWith({ platform: "ios" });
    expect(warn).toHaveBeenCalledWith(
      "No ios native project to read the app version from.\nRunning the test build adapter's prebuild to write it.",
    );
    expect(output()).toMatchObject({ channel: "qa", appVersion: "2.1.0" });
  });

  it.each([
    ["an APK scheme", "android", "releaseAab", "apk"],
    ["a Simulator scheme", "ios", "device", "app"],
  ] as const)(
    "prints no build when the newest is not the artifact %s's counterpart builds",
    async (_, platform, scheme, kind) => {
      await databaseHarness.core.registerNativeBuild({
        platform,
        channel: "preview",
        fingerprintHash: "fingerprint-a",
        appVersion: null,
        id: "01900000-0000-7000-8000-00000000b001",
        minBundleId: "01900000-0000-7000-8000-00000000a001",
        gitCommitHash: null,
        buildKey: null,
        artifact: {
          kind,
          storageUri: `storage://native-builds/${platform}/b001/artifact`,
          byteSize: 1_024,
        },
        embeddedBundle: {
          manifestStorageUri: "storage://artifacts/a001/manifest.json",
          manifestFileHash: "manifest-hash-1",
          assetBaseStorageUri: "storage://artifacts/a001/assets",
        },
      } as NativeBuildRegistration);
      const { handleNativeBuildFind } = await import("./nativeBuild");

      await handleNativeBuildFind({ platform, scheme, json: true });
      expect(output().nativeBuild).toBeNull();

      // The scheme that builds that kind reuses it.
      await handleNativeBuildFind({
        platform,
        scheme: platform === "android" ? "releaseApk" : "simulator",
        json: true,
      });
      expect(output().nativeBuild).toMatchObject({ artifact_kind: kind });
    },
  );

  it("fails before reading the registry when the project builds several app versions and no scheme picks one", async () => {
    loadConfig.mockResolvedValue({
      updateStrategy: "appVersion",
      nativeBuild,
      build,
    });
    resolveNativeAppVersion.mockResolvedValue({
      version: null,
      candidates: [
        { label: "a", version: "1.0.0" },
        { label: "b", version: "2.0.0" },
      ],
    });
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await expect(
      handleNativeBuildFind({ platform: "android", json: true }),
    ).rejects.toThrow("process.exit");

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Pass --scheme"),
    );
    expect(loadServer).not.toHaveBeenCalled();
  });

  it("fails on a scheme the config doesn't define", async () => {
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await expect(
      handleNativeBuildFind({ platform: "android", scheme: "simulator" }),
    ).rejects.toThrow("process.exit");

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("nativeBuild.android"),
    );
    expect(loadServer).not.toHaveBeenCalled();
  });
});
