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

vi.mock("@hot-updater/cli-tools", () => ({
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
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(),
    promises: {
      mkdir: vi.fn(),
      readdir: vi.fn(),
      rm: vi.fn(),
    },
    statSync: vi.fn(),
  },
}));

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
import { validateSigningConfig } from "@/utils/signing/validateSigningConfig";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";
import { deploy, normalizeRolloutPercentage } from "./deploy";

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

  it("stores rolloutPercentage=100 when deploy options omit rollout", async () => {
    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockDatabasePlugin.appendBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        rolloutPercentage: 100,
      }),
    );
  });

  it("stores an explicit rolloutPercentage on the created bundle", async () => {
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
        rolloutPercentage: 0,
      }),
    );
  });
});
