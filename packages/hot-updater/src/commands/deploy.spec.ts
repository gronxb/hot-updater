import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockBuildPlugin, mockCli, mockDatabasePlugin, mockStoragePlugin } =
  vi.hoisted(() => {
    const mockBuildPlugin = {
      build: vi.fn(),
      name: "mock-build",
    };
    const mockStoragePlugin = {
      name: "mock-storage",
      upload: vi.fn(),
    };
    const mockDatabasePlugin = {
      appendBundle: vi.fn(),
      commitBundle: vi.fn(),
      deleteBundle: vi.fn(),
      getBundleById: vi.fn(),
      getBundles: vi.fn(),
      getChannels: vi.fn(),
      name: "mock-database",
      onUnmount: vi.fn(),
      updateBundle: vi.fn(),
    };
    const mockCli = {
      appendToProjectRootGitignore: vi.fn(),
      createTarBrTargetFiles: vi.fn(),
      createTarGzTargetFiles: vi.fn(),
      createZipTargetFiles: vi.fn(),
      getCwd: vi.fn(),
      loadConfig: vi.fn(),
      p: {
        confirm: vi.fn(),
        isCancel: vi.fn(),
        log: {
          error: vi.fn(),
          info: vi.fn(),
          step: vi.fn(),
          success: vi.fn(),
          warn: vi.fn(),
        },
        note: vi.fn(),
        outro: vi.fn(),
        spinner: vi.fn(),
        tasks: vi.fn(),
        text: vi.fn(),
      },
    };

    return { mockBuildPlugin, mockCli, mockDatabasePlugin, mockStoragePlugin };
  });

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();

  return {
    ...actual,
    HotUpdateDirUtil: {
      getDefaultOutputPath: vi.fn(() => ".hot-updater/output"),
      outputGitignorePath: ".hot-updater/output",
    },
    colors: {
      blueBright: (value: string) => value,
      magenta: (value: string) => value,
      underline: (value: string) => value,
    },
    createTarBrTargetFiles: mockCli.createTarBrTargetFiles,
    createTarGzTargetFiles: mockCli.createTarGzTargetFiles,
    createZipTargetFiles: mockCli.createZipTargetFiles,
    getCwd: mockCli.getCwd,
    loadConfig: mockCli.loadConfig,
    p: mockCli.p,
  };
});

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      promises: {
        ...actual.promises,
        mkdir: vi.fn(),
        readdir: vi.fn(),
        rm: vi.fn(),
      },
      statSync: vi.fn(),
    },
    existsSync: vi.fn(),
    promises: {
      ...actual.promises,
      mkdir: vi.fn(),
      readdir: vi.fn(),
      rm: vi.fn(),
    },
    statSync: vi.fn(),
  };
});

vi.mock("is-port-reachable", () => ({
  default: vi.fn(),
}));

vi.mock("open", () => ({
  default: vi.fn(),
}));

vi.mock("@/prompts/getPlatform", () => ({
  getPlatform: vi.fn(),
}));

vi.mock("@/signedHashUtils", () => ({
  createSignedFileHash: vi.fn((value: string) => `sig:${value}`),
}));

vi.mock("@/utils/bundleManifest", () => ({
  writeBundleManifest: vi.fn(),
}));

vi.mock("@/utils/fingerprint", () => ({
  isFingerprintEquals: vi.fn(),
  nativeFingerprint: vi.fn(),
  readLocalFingerprint: vi.fn(),
}));

vi.mock("@/utils/fingerprint/diff", () => ({
  getFingerprintDiff: vi.fn(),
  showFingerprintDiff: vi.fn(),
}));

vi.mock("@/utils/getBundleZipTargets", () => ({
  getBundleZipTargets: vi.fn(),
}));

vi.mock("@/utils/getFileHash", () => ({
  getFileHashFromFile: vi.fn(),
}));

vi.mock("@/utils/git", () => ({
  appendToProjectRootGitignore: mockCli.appendToProjectRootGitignore,
  getLatestGitCommit: vi.fn(),
}));

vi.mock("@/utils/printBanner", () => ({
  printBanner: vi.fn(),
}));

vi.mock("@/utils/signing/bundleSigning", () => ({
  signBundle: vi.fn(),
}));

vi.mock("@/utils/signing/validateSigningConfig", () => ({
  validateSigningConfig: vi.fn(),
}));

vi.mock("@/utils/version/getDefaultTargetAppVersion", () => ({
  getDefaultTargetAppVersion: vi.fn(),
}));

vi.mock("@/utils/version/getNativeAppVersion", () => ({
  getNativeAppVersion: vi.fn(),
}));

vi.mock("./console", () => ({
  getConsolePort: vi.fn(),
  openConsole: vi.fn(),
}));

import fs from "fs";

import { writeBundleManifest } from "@/utils/bundleManifest";
import { getBundleZipTargets } from "@/utils/getBundleZipTargets";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { getLatestGitCommit } from "@/utils/git";
import { printBanner } from "@/utils/printBanner";
import { signBundle } from "@/utils/signing/bundleSigning";
import { validateSigningConfig } from "@/utils/signing/validateSigningConfig";
import { getDefaultTargetAppVersion } from "@/utils/version/getDefaultTargetAppVersion";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";

import { getConsolePort } from "./console";
import {
  deploy,
  getRolloutCohortCountFromPercentage,
  normalizeRolloutPercentage,
} from "./deploy";

describe("normalizeRolloutPercentage", () => {
  it("defaults to 100 when rollout is omitted", () => {
    expect(normalizeRolloutPercentage(undefined)).toBe(100);
  });

  it("accepts string and number inputs between 0 and 100", () => {
    expect(normalizeRolloutPercentage("0")).toBe(0);
    expect(normalizeRolloutPercentage(55)).toBe(55);
    expect(normalizeRolloutPercentage("100")).toBe(100);
  });

  it("rejects rollout values outside the allowed range", () => {
    expect(() => normalizeRolloutPercentage("-1")).toThrow(
      "Rollout percentage must be an integer between 0 and 100",
    );
    expect(() => normalizeRolloutPercentage("101")).toThrow(
      "Rollout percentage must be an integer between 0 and 100",
    );
    expect(() => normalizeRolloutPercentage("12.5")).toThrow(
      "Rollout percentage must be an integer between 0 and 100",
    );
  });
});

describe("getRolloutCohortCountFromPercentage", () => {
  it("maps rollout percentages to 1..1000 cohort counts", () => {
    expect(getRolloutCohortCountFromPercentage(0)).toBe(0);
    expect(getRolloutCohortCountFromPercentage(55)).toBe(550);
    expect(getRolloutCohortCountFromPercentage(100)).toBe(1000);
  });
});

describe("deploy rollout wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockCli.getCwd.mockReturnValue("/mock/cwd");
    mockCli.appendToProjectRootGitignore.mockReturnValue(false);
    mockCli.p.isCancel.mockReturnValue(false);
    mockCli.p.spinner.mockReturnValue({
      error: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    });
    mockCli.p.tasks.mockImplementation(async (tasks) => {
      for (const task of tasks) {
        await task.task();
      }
    });

    mockBuildPlugin.build.mockResolvedValue({
      buildPath: "/mock/build",
      bundleId: "bundle-123",
      stdout: null,
    });
    mockStoragePlugin.upload.mockResolvedValue({
      storageUri: "s3://bundles/bundle-123/bundle.tar.br",
    });
    mockDatabasePlugin.appendBundle.mockResolvedValue(undefined);
    mockDatabasePlugin.commitBundle.mockResolvedValue(undefined);
    mockDatabasePlugin.onUnmount.mockResolvedValue(undefined);

    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: async () => mockDatabasePlugin,
      fingerprint: {},
      signing: { enabled: false },
      storage: async () => mockStoragePlugin,
      updateStrategy: "appVersion",
    });

    vi.mocked(validateSigningConfig).mockResolvedValue({
      isValid: true,
      issues: [],
      nativePublicKeys: {
        android: { exists: false, paths: [] },
        ios: { exists: false, paths: [] },
      },
      signingEnabled: false,
    });
    vi.mocked(getLatestGitCommit).mockResolvedValue({
      id: () => "git-hash",
      summary: () => "git summary",
    } as Awaited<ReturnType<typeof getLatestGitCommit>>);
    vi.mocked(getDefaultTargetAppVersion).mockResolvedValue(null);
    vi.mocked(getNativeAppVersion).mockResolvedValue("1.0");
    vi.mocked(writeBundleManifest).mockResolvedValue({
      manifest: {
        assets: {},
        bundleId: "bundle-123",
      },
      manifestPath: "/mock/build/manifest.json",
    });
    vi.mocked(getBundleZipTargets).mockResolvedValue([
      {
        name: "index.bundle",
        path: "/mock/build/index.bundle",
      },
    ]);
    vi.mocked(getFileHashFromFile).mockResolvedValue("file-hash");

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.promises.readdir).mockResolvedValue([
      "index.bundle",
    ] as unknown as Awaited<ReturnType<typeof fs.promises.readdir>>);
    vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => false,
    } as ReturnType<typeof fs.statSync>);
  });

  it("stores rolloutCohortCount=1000 when deploy options omit rollout", async () => {
    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockDatabasePlugin.appendBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        rolloutCohortCount: 1000,
      }),
    );
  });

  it("stores an explicit rolloutCohortCount on the created bundle", async () => {
    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      rollout: 0,
      targetAppVersion: "1.0.x",
    });

    expect(mockDatabasePlugin.appendBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        rolloutCohortCount: 0,
      }),
    );
  });

  it("converts rollout percentages to rollout cohort counts before storing", async () => {
    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      rollout: 55,
      targetAppVersion: "1.0.x",
    });

    expect(mockDatabasePlugin.appendBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        rolloutCohortCount: 550,
      }),
    );
  });

  it("prints deployment context and success outro", async () => {
    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockCli.p.note).toHaveBeenCalledWith(
      "Platform: iOS\nChannel: production\nRollout: 100%\nTarget app version: >=1.0.0 <1.1.0-0",
      "Deployment",
    );
    expect(mockCli.p.outro).toHaveBeenCalledWith(
      "🚀 Deployment Successful (bundle-123)",
    );
  });

  it("deploys both platforms sequentially when platform is omitted", async () => {
    mockBuildPlugin.build.mockImplementation(async ({ platform }) => ({
      buildPath: "/mock/build",
      bundleId: platform === "ios" ? "bundle-ios" : "bundle-android",
      stdout: null,
    }));

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      targetAppVersion: "1.0.x",
    });

    expect(printBanner).toHaveBeenCalledTimes(1);
    expect(mockBuildPlugin.build.mock.calls).toEqual([
      [{ platform: "ios" }],
      [{ platform: "android" }],
    ]);
    expect(mockCli.p.note).toHaveBeenNthCalledWith(
      1,
      "Platform: Both (iOS, Android)\nChannel: production\nRollout: 100%\nTarget app version: >=1.0.0 <1.1.0-0",
      "Deployment",
    );
    expect(mockCli.p.log.step).toHaveBeenNthCalledWith(
      1,
      "Deployment (iOS 1/2) • production",
    );
    expect(mockCli.p.log.step).toHaveBeenNthCalledWith(
      2,
      "Deployment (Android 2/2) • production",
    );
    expect(mockCli.createTarBrTargetFiles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outfile: "/mock/cwd/.hot-updater/output/ios/bundle/bundle.tar.br",
      }),
    );
    expect(mockCli.createTarBrTargetFiles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        outfile: "/mock/cwd/.hot-updater/output/android/bundle/bundle.tar.br",
      }),
    );
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      "✅ iOS Deployment Successful (bundle-ios)",
    );
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      "✅ Android Deployment Successful (bundle-android)",
    );
    expect(mockCli.p.outro).toHaveBeenCalledWith(
      "🚀 Deployment Successful (iOS, Android)",
    );
  });

  it("renders build stdout in a note instead of raw task output", async () => {
    mockBuildPlugin.build.mockResolvedValue({
      buildPath: "/mock/build",
      bundleId: "bundle-123",
      stdout: "LLVM\nHermes",
    });

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockCli.p.note).toHaveBeenCalledWith("LLVM\nHermes", "Build Output");
  });

  it("does not create a nested spinner when signing is enabled", async () => {
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: async () => mockDatabasePlugin,
      fingerprint: {},
      signing: { enabled: true, privateKeyPath: "/mock/private.pem" },
      storage: async () => mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    mockBuildPlugin.build.mockResolvedValue({
      buildPath: "/mock/build",
      bundleId: "bundle-123",
      stdout: "LLVM\nHermes",
    });
    vi.mocked(signBundle).mockResolvedValue("signature");

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(signBundle).toHaveBeenCalledWith("file-hash", "/mock/private.pem");
    expect(mockCli.p.spinner).not.toHaveBeenCalled();
    expect(mockCli.p.note).toHaveBeenCalledWith("LLVM\nHermes", "Build Output");
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      "✅ Bundle Signing Complete",
    );
    expect(mockCli.p.note).toHaveBeenCalledWith(
      "Platform: iOS\nChannel: production\nRollout: 100%\nTarget app version: >=1.0.0 <1.1.0-0",
      "Deployment",
    );

    const buildOutputOrder = mockCli.p.note.mock.calls.findIndex(
      ([message, title]) =>
        message === "LLVM\nHermes" && title === "Build Output",
    );
    const signingOrder = mockCli.p.log.success.mock.calls.findIndex(
      ([message]) => message === "✅ Bundle Signing Complete",
    );

    expect(buildOutputOrder).toBeGreaterThanOrEqual(0);
    expect(signingOrder).toBeGreaterThanOrEqual(0);
  });

  it("falls back to the auto-detected target app version in non-interactive mode when -t is omitted", async () => {
    vi.mocked(getDefaultTargetAppVersion).mockResolvedValue("1.5.0");

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
    });

    expect(mockDatabasePlugin.appendBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAppVersion: "1.5.0",
      }),
    );
  });

  it("errors out in non-interactive mode when -t is omitted and the native config is unreadable", async () => {
    vi.mocked(getDefaultTargetAppVersion).mockResolvedValue(null);

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
    });

    expect(mockCli.p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Target app version not found in native files"),
    );
    expect(mockDatabasePlugin.appendBundle).not.toHaveBeenCalled();
  });

  it("uses the explicit -t value over the auto-detected default", async () => {
    vi.mocked(getDefaultTargetAppVersion).mockResolvedValue("1.5.0");

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.2.0",
    });

    expect(mockDatabasePlugin.appendBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAppVersion: "1.2.0",
      }),
    );
  });

  it("uses the interactive prompt with the auto-detected value as placeholder/initialValue", async () => {
    vi.mocked(getDefaultTargetAppVersion).mockResolvedValue("1.5.0");
    vi.mocked(getConsolePort).mockResolvedValue(3000);
    mockCli.p.text.mockResolvedValue("1.7.0");

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: true,
      platform: "ios",
    });

    expect(mockCli.p.text).toHaveBeenCalledWith(
      expect.objectContaining({
        placeholder: "1.5.0",
        initialValue: "1.5.0",
      }),
    );
    expect(mockDatabasePlugin.appendBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAppVersion: "1.7.0",
      }),
    );
  });
});
