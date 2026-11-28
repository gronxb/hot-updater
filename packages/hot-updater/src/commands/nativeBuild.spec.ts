import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  createStorageAdapter,
  type NativeBuildRegistration,
} from "@hot-updater/plugin-core";
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
  log: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
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
    "platform" | "channel" | "fingerprintHash" | "appVersion" | "isSandbox"
  > &
    Pick<
      Partial<NativeBuildRegistration>,
      "sandboxUrlScheme" | "sandboxAppId" | "nativeAppVersion"
    >,
  kind: NativeBuildRegistration["artifact"]["kind"] = scope.platform ===
  "android"
    ? "apk"
    : "app",
) =>
  databaseHarness.core.registerNativeBuild({
    ...scope,
    id: `01900000-0000-7000-8000-00000000b${suffix.padStart(3, "0")}`,
    minBundleId: `01900000-0000-7000-8000-00000000a${suffix.padStart(3, "0")}`,
    gitCommitHash: null,
    buildKey: null,
    artifact: {
      kind,
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

const sandboxSchemes = {
  android: {
    ...nativeBuild.android,
    sandbox: {
      packageName: "com.example",
      variant: "Release",
      aab: false,
      sandbox: true,
    },
  },
  ios: {
    ...nativeBuild.ios,
    sandbox: {
      scheme: "Example",
      bundleIdentifier: "com.example.sandbox",
      configuration: "Release",
      simulator: true,
      sandbox: true,
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
  describe("with a sandbox scheme", () => {
    const find = async (
      platform: "android" | "ios",
      scheme = "sandbox",
      channel?: string,
    ) => {
      const { handleNativeBuildFind } = await import("./nativeBuild");
      await handleNativeBuildFind({
        platform,
        scheme,
        json: true,
        ...(channel === undefined ? {} : { channel }),
      });
      return output();
    };
    /** A sandbox build of the scheme, as its artifact registers it. */
    const sandboxBuild = (platform: "android" | "ios", channel: string) => ({
      platform,
      channel,
      appVersion: null,
      isSandbox: true as const,
      // Android's application ID has the sandbox's suffix.
      sandboxAppId: "com.example.sandbox",
      sandboxUrlScheme:
        platform === "android"
          ? "hu-sandbox-com-example"
          : "hu-sandbox-com-example-sandbox",
    });

    beforeEach(() => {
      loadConfig.mockResolvedValue({
        updateStrategy: "fingerprint",
        nativeBuild: sandboxSchemes,
        build,
      });
    });

    it("names the scheme's app ID, and the project's channel a new build embeds", async () => {
      expect(await find("android")).toMatchObject({
        channel: "preview",
        nativeBuild: null,
        sandbox: {
          appId: "com.example",
          urlScheme: "hu-sandbox-com-example",
          channel: null,
        },
      });
    });

    it("names the iOS scheme's own bundle identifier", async () => {
      expect((await find("ios")).sandbox.appId).toBe("com.example.sandbox");
    });

    it("finds a sandbox build another pull request's channel embeds, and names that channel", async () => {
      const built = await register("1", {
        ...sandboxBuild("android", "pr-120"),
        fingerprintHash: "fingerprint-a",
      });
      getChannel.mockResolvedValue({ value: "pr-140", paths: [] });

      expect(await find("android")).toMatchObject({
        channel: "pr-140",
        nativeBuild: { id: built.id, is_sandbox: true },
        sandbox: { channel: "pr-120" },
      });
    });

    it("takes the channel a new build would embed", async () => {
      expect(await find("android", "sandbox", "pr-140")).toMatchObject({
        channel: "pr-140",
        nativeBuild: null,
        sandbox: { channel: null },
      });
    });

    it("finds no build of other native code, and no normal build of the same", async () => {
      await register("1", {
        ...sandboxBuild("android", "preview"),
        fingerprintHash: "fingerprint-old",
      });
      await register("2", {
        platform: "android",
        channel: "preview",
        fingerprintHash: "fingerprint-a",
        appVersion: null,
        isSandbox: false,
      });

      expect(await find("android")).toMatchObject({
        nativeBuild: null,
        sandbox: { channel: null },
      });
    });

    describe("the URL scheme its links open", () => {
      const withUrlScheme = (urlScheme: string) =>
        loadConfig.mockResolvedValue({
          updateStrategy: "fingerprint",
          nativeBuild: {
            ...sandboxSchemes,
            android: {
              ...sandboxSchemes.android,
              sandbox: {
                ...sandboxSchemes.android.sandbox,
                sandboxUrlScheme: urlScheme,
              },
            },
          },
          build,
        });

      it("is the derived one for a scheme that sets none", async () => {
        expect((await find("android")).sandbox.urlScheme).toBe(
          "hu-sandbox-com-example",
        );
        expect((await find("ios")).sandbox.urlScheme).toBe(
          "hu-sandbox-com-example-sandbox",
        );
      });

      it("is the configured one, and a build of another one isn't found", async () => {
        withUrlScheme("acme-preview");
        await register("1", {
          ...sandboxBuild("android", "preview"),
          fingerprintHash: "fingerprint-a",
          sandboxUrlScheme: "acme-next",
        });
        expect(await find("android")).toMatchObject({
          nativeBuild: null,
          sandbox: {
            appId: "com.example",
            urlScheme: "acme-preview",
            channel: null,
          },
        });
        const built = await register("2", {
          ...sandboxBuild("android", "preview"),
          fingerprintHash: "fingerprint-a",
          sandboxUrlScheme: "acme-preview",
        });
        expect((await find("android")).nativeBuild?.id).toBe(built.id);
      });
    });

    it("tags the build it finds as a sandbox build in its text", async () => {
      await register("1", {
        ...sandboxBuild("android", "preview"),
        fingerprintHash: "fingerprint-a",
      });
      const { handleNativeBuildFind } = await import("./nativeBuild");

      await handleNativeBuildFind({ platform: "android", scheme: "sandbox" });

      const printed = stripVTControlCharacters(
        String(log.success.mock.calls.at(-1)?.[0]),
      );
      expect(printed).toMatch(/Kind\s+apk · sandbox/);
    });

    it("names a fingerprint build's own app version in its text", async () => {
      await register("1", {
        ...sandboxBuild("android", "preview"),
        fingerprintHash: "fingerprint-a",
        nativeAppVersion: "1.6.0",
      });
      const { handleNativeBuildFind } = await import("./nativeBuild");

      await handleNativeBuildFind({ platform: "android", scheme: "sandbox" });

      const printed = stripVTControlCharacters(
        String(log.success.mock.calls.at(-1)?.[0]),
      );
      expect(printed).toMatch(
        /Fingerprint\s+fingerprint-a\n\s*App version\s+1\.6\.0/,
      );
      // A script reads it from the build itself.
      expect((await find("android", "sandbox")).nativeBuild).toMatchObject({
        app_version: null,
        native_app_version: "1.6.0",
      });
    });

    it("adds nothing for a scheme that isn't a sandbox's", async () => {
      expect(await find("android", "releaseApk")).not.toHaveProperty("sandbox");
    });
  });

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
      downloadUrl: null,
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

  it("finds the scheme's kind past a newer build of another kind of the scope", async () => {
    const scope = {
      platform: "ios",
      channel: "preview",
      fingerprintHash: "fingerprint-a",
      appVersion: null,
    } as const;
    await register("1", scope, "ipa");
    // The same native code's Simulator build, registered after the .ipa.
    await register("2", scope, "app");
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await handleNativeBuildFind({
      platform: "ios",
      scheme: "device",
      json: true,
    });
    expect(output().nativeBuild).toMatchObject({
      id: "01900000-0000-7000-8000-00000000b001",
      artifact_kind: "ipa",
    });
    await handleNativeBuildFind({
      platform: "ios",
      scheme: "simulator",
      json: true,
    });
    expect(output().nativeBuild).toMatchObject({
      id: "01900000-0000-7000-8000-00000000b002",
      artifact_kind: "app",
    });
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
        downloadUrl: null,
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
      downloadUrl: null,
    });
  });

  it("gives a script the URL and the ID it downloads the build by", async () => {
    await register("1", {
      platform: "android",
      channel: "preview",
      fingerprintHash: "fingerprint-a",
      appVersion: null,
    });
    const url = "https://cdn.example.com/app.apk?signature=x";
    const bytes = new Uint8Array(1_024).fill(7);
    const getDownloadUrl = vi.fn(async () => ({ url }));
    loadServer.mockResolvedValue(
      testServer({
        database: databaseHarness.database,
        storage: createStorageAdapter({
          name: "fake",
          protocol: "storage",
          get: async () => ({ response: new Response(bytes) }),
          getDownloadUrl,
        }),
      }),
    );
    const { handleNativeBuildDownload, handleNativeBuildFind } =
      await import("./nativeBuild");

    await handleNativeBuildFind({ platform: "android", json: true });

    const found = output();
    expect(found.downloadUrl).toBe(url);
    // The fields a script read before this one stay.
    expect(found.nativeBuild.artifact_storage_uri).toBe(
      "storage://native-builds/android/b001/artifact",
    );
    expect(getDownloadUrl).toHaveBeenCalledWith({
      storageUri: found.nativeBuild.artifact_storage_uri,
    });

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "find-"));
    try {
      const file = path.join(directory, "app.apk");
      await handleNativeBuildDownload(found.nativeBuild.id, {
        json: true,
        output: file,
      });
      expect(output()).toMatchObject({ path: file, byteSize: 1_024 });
      expect(await fs.readFile(file)).toEqual(Buffer.from(bytes));
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  });

  it("asks the storage for no URL without a build, or without --json", async () => {
    const getDownloadUrl = vi.fn(async () => ({ url: "https://example.com" }));
    loadServer.mockResolvedValue(
      testServer({
        database: databaseHarness.database,
        storage: createStorageAdapter({
          name: "fake",
          protocol: "storage",
          getDownloadUrl,
        }),
      }),
    );
    const { handleNativeBuildFind } = await import("./nativeBuild");

    await handleNativeBuildFind({ platform: "android", json: true });
    expect(output().downloadUrl).toBeNull();

    await register("1", {
      platform: "android",
      channel: "preview",
      fingerprintHash: "fingerprint-a",
      appVersion: null,
    });
    await handleNativeBuildFind({ platform: "android" });

    expect(getDownloadUrl).not.toHaveBeenCalled();
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

  describe("a sandbox scheme", () => {
    const find = async (
      options: Parameters<
        typeof import("./nativeBuild").handleNativeBuildFind
      >[0],
    ) => (await import("./nativeBuild")).handleNativeBuildFind(options);
    const withSandbox = {
      android: {
        ...nativeBuild.android,
        beta: {
          packageName: "com.example",
          variant: "Release",
          aab: false,
          sandbox: true,
        },
      },
      ios: nativeBuild.ios,
    };

    beforeEach(() => {
      loadConfig.mockResolvedValue({
        updateStrategy: "fingerprint",
        nativeBuild: withSandbox,
        build,
      });
    });

    it("looks on the native project's channel for a new build, and finds a sandbox build on any", async () => {
      const scope = {
        platform: "android",
        fingerprintHash: "fingerprint-a",
        appVersion: null,
      } as const;
      await register("1", {
        ...scope,
        channel: "pr-120",
        isSandbox: true,
        sandboxUrlScheme: "hu-sandbox-com-example",
        sandboxAppId: "com.example.sandbox",
      });
      await register("2", { ...scope, channel: "preview" });

      await find({ platform: "android", scheme: "beta", json: true });

      const printed = output();
      expect(printed.channel).toBe("preview");
      expect(printed.nativeBuild.id).toContain("1");
      expect(printed.sandbox.channel).toBe("pr-120");
    });

    it("takes any channel, one named sandbox-* too", async () => {
      await find({
        platform: "android",
        scheme: "releaseApk",
        channel: "sandbox-beta",
        json: true,
      });
      expect(output().channel).toBe("sandbox-beta");
    });
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
