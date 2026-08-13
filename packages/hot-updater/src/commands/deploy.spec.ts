import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockBuildPlugin, mockCli, mockServer, mockStoragePlugin } = vi.hoisted(
  () => {
    const mockBuildPlugin = {
      build: vi.fn(),
      name: "mock-build",
    };
    const mockStoragePlugin = {
      delete: vi.fn(),
      exists: vi.fn(),
      get: vi.fn(),
      name: "mock-storage",
      protocol: "s3",
      put: vi.fn(),
    };
    const mockServer = {
      createBundleDiff: vi.fn(),
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

    return {
      mockBuildPlugin,
      mockCli,
      mockServer,
      mockStoragePlugin,
    };
  },
);

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
    putStorageFile: (
      storage: typeof mockStoragePlugin,
      key: string,
      filePath: string,
    ) =>
      storage.put({
        key: [key, filePath.split("/").at(-1)!].filter(Boolean).join("/"),
        body: new Response("file").body!,
        contentLength: 4,
        contentType: "application/octet-stream",
      }),
  };
});

vi.mock("@hot-updater/server/db", () => ({
  createBundleDiff: mockServer.createBundleDiff,
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      createReadStream: vi.fn(),
      createWriteStream: vi.fn(),
      existsSync: vi.fn(),
      promises: {
        ...actual.promises,
        copyFile: vi.fn(),
        mkdir: vi.fn(),
        readFile: vi.fn(),
        readdir: vi.fn(),
        rm: vi.fn(),
        writeFile: vi.fn(),
      },
      statSync: vi.fn(),
    },
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
    existsSync: vi.fn(),
    promises: {
      ...actual.promises,
      copyFile: vi.fn(),
      mkdir: vi.fn(),
      readFile: vi.fn(),
      readdir: vi.fn(),
      rm: vi.fn(),
      writeFile: vi.fn(),
    },
    statSync: vi.fn(),
  };
});

vi.mock("is-port-reachable", () => ({
  default: vi.fn(),
}));

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";

const databaseHarness = createDatabasePluginHarness();
const databasePlugin = databaseHarness.plugin;

vi.mock("open", () => ({
  default: vi.fn(),
}));

vi.mock("stream/promises", () => ({
  pipeline: vi.fn(async () => {}),
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

import type { DatabasePlugin, LegacyBundle } from "@hot-updater/plugin-core";
import {
  createStorageUri,
  DatabaseAtomicCommitUnsupportedError,
} from "@hot-updater/plugin-core";

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
  normalizePatchMaxBaseBundles,
  normalizeRolloutPercentage,
} from "./deploy";

type BundleFixture = Pick<LegacyBundle, "id"> & Partial<LegacyBundle>;

const fixtureBundleId = (sequence: number): string =>
  `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
const DEPLOY_BUNDLE_ID = fixtureBundleId(123);

const mockGetBundlesWithFixtures = (fixtures: BundleFixture[]) => {
  mockBuildPlugin.build.mockResolvedValue({
    buildPath: "/mock/build",
    bundleId: DEPLOY_BUNDLE_ID,
    stdout: null,
  });
  mockServer.createBundleDiff.mockResolvedValue({ id: DEPLOY_BUNDLE_ID });
  return databaseHarness.seedLegacyBundles(
    fixtures.map((fixture) => ({
      channel: "production",
      enabled: true,
      fileHash: "fixture-hash",
      fingerprintHash: null,
      gitCommitHash: null,
      message: null,
      platform: "ios",
      rolloutCohortCount: 1000,
      shouldForceUpdate: false,
      storageUri: `storage://${fixture.id}`,
      targetAppVersion: null,
      ...fixture,
    })),
  );
};

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

describe("normalizePatchMaxBaseBundles", () => {
  it("defaults to 3 when maxBaseBundles is omitted", () => {
    expect(normalizePatchMaxBaseBundles(undefined)).toBe(3);
  });

  it("accepts positive integer values", () => {
    expect(normalizePatchMaxBaseBundles(1)).toBe(1);
    expect(normalizePatchMaxBaseBundles(5)).toBe(5);
    expect(normalizePatchMaxBaseBundles(6)).toBe(6);
  });

  it("rejects non-positive or non-integer values", () => {
    expect(() => normalizePatchMaxBaseBundles(0)).toThrow(
      "Patch maxBaseBundles must be a positive integer",
    );
    expect(() => normalizePatchMaxBaseBundles(2.5)).toThrow(
      "Patch maxBaseBundles must be a positive integer",
    );
  });
});

describe("deploy rollout wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();

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
    mockStoragePlugin.put.mockImplementation(async ({ key }) => ({
      storageUri: `s3://bundles/${key}`,
    }));
    mockStoragePlugin.exists.mockResolvedValue({ exists: false });
    mockServer.createBundleDiff.mockResolvedValue({
      id: "bundle-123",
    });

    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: databasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 3,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
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
    vi.mocked(writeBundleManifest).mockImplementation(
      async ({ bundleId, targetFiles }) => ({
        manifest: {
          assets: Object.fromEntries(
            targetFiles.map((targetFile) => {
              const fileHash = "file-hash";
              return [
                targetFile.name,
                {
                  fileHash,
                },
              ];
            }),
          ),
          bundleId,
        },
        manifestPath: "/mock/build/manifest.json",
      }),
    );
    vi.mocked(getBundleZipTargets).mockResolvedValue([
      {
        name: "index.bundle",
        path: "/mock/build/index.bundle",
      },
    ]);
    vi.mocked(getFileHashFromFile).mockResolvedValue("file-hash");

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.promises.copyFile).mockResolvedValue(undefined);
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from("bundle"));
    vi.mocked(fs.promises.readdir).mockResolvedValue([
      "index.bundle",
    ] as unknown as Awaited<ReturnType<typeof fs.promises.readdir>>);
    vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
    vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);
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

    expect((await databaseHarness.releases())[0]).toMatchObject({
      rollout_cohort_count: 1000,
    });
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

    expect((await databaseHarness.releases())[0]).toMatchObject({
      rollout_cohort_count: 0,
    });
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

    expect((await databaseHarness.releases())[0]).toMatchObject({
      rollout_cohort_count: 550,
    });
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
    expect(
      (await databaseHarness.bundles()).map(({ id }) => id).sort(),
    ).toEqual(["bundle-android", "bundle-ios"]);
    expect(await databasePlugin.models.channels.list({})).toEqual({
      channels: [
        expect.objectContaining({
          name: "production",
        }),
      ],
    });
    expect(databaseHarness.commit).toHaveBeenCalledTimes(1);
  });

  it("does not partially persist an unsupported two-platform commit", async () => {
    const transactionlessDatabasePlugin: DatabasePlugin = {
      ...databasePlugin,
      commit: async (input) => {
        if (input.changes.length > 1) {
          throw new DatabaseAtomicCommitUnsupportedError(databasePlugin.name);
        }
        return databasePlugin.commit(input);
      },
    };
    const commit = vi.spyOn(transactionlessDatabasePlugin, "commit");
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: transactionlessDatabasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 3,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    mockBuildPlugin.build.mockImplementation(async ({ platform }) => ({
      buildPath: "/mock/build",
      bundleId: platform === "ios" ? "bundle-ios" : "bundle-android",
      stdout: null,
    }));

    const deployment = deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      targetAppVersion: "1.0.x",
    });

    await expect(deployment).rejects.toBeInstanceOf(
      DatabaseAtomicCommitUnsupportedError,
    );
    expect(mockBuildPlugin.build).toHaveBeenCalledTimes(2);
    expect(mockStoragePlugin.put).toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    expect(await databaseHarness.bundles()).toEqual([]);
    expect(transactionlessDatabasePlugin.dispose).toHaveBeenCalledOnce();
  });

  it("rejects distinct platform databases before building and cleans both up", async () => {
    const iosDatabasePlugin: DatabasePlugin = {
      ...databasePlugin,
      dispose: vi.fn(async (): Promise<void> => {}),
    };
    const androidDatabasePlugin: DatabasePlugin = {
      ...databasePlugin,
      dispose: vi.fn(async (): Promise<void> => {}),
    };
    mockCli.loadConfig.mockImplementation(async ({ platform }) => ({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: platform === "ios" ? iosDatabasePlugin : androidDatabasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 3,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    }));

    const deployment = deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      targetAppVersion: "1.0.x",
    });

    await expect(deployment).rejects.toThrow(
      "Deploying multiple platforms requires a shared database configuration.",
    );
    expect(mockBuildPlugin.build).not.toHaveBeenCalled();
    expect(mockStoragePlugin.put).not.toHaveBeenCalled();
    expect(iosDatabasePlugin.dispose).toHaveBeenCalledOnce();
    expect(androidDatabasePlugin.dispose).toHaveBeenCalledOnce();
  });

  it("commits a transactionless single-platform deployment exactly once", async () => {
    const transactionlessDatabasePlugin = databasePlugin;
    const commit = vi.spyOn(transactionlessDatabasePlugin, "commit");
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: transactionlessDatabasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 3,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(commit).toHaveBeenCalledOnce();
  });

  it("does not print deployment success when the database commit fails", async () => {
    const commitError = new Error("commit failed");
    const failingDatabasePlugin: DatabasePlugin = {
      ...databasePlugin,
      commit: async () => {
        throw commitError;
      },
    };
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: failingDatabasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 3,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    mockBuildPlugin.build.mockImplementation(async ({ platform }) => ({
      buildPath: "/mock/build",
      bundleId: platform === "ios" ? "bundle-ios" : "bundle-android",
      stdout: null,
    }));

    const deployment = deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      targetAppVersion: "1.0.x",
    });

    await expect(deployment).rejects.toBe(commitError);
    expect(mockCli.p.log.success).not.toHaveBeenCalled();
    expect(mockCli.p.outro).not.toHaveBeenCalled();
  });

  it("runs deployment side effects once when a provider retries its commit internally", async () => {
    const originalCommit = databasePlugin.commit;
    let commitAttemptCount = 0;
    const retryingDatabasePlugin: DatabasePlugin = {
      ...databasePlugin,
      commit: async (input) => {
        commitAttemptCount += 2;
        return originalCommit(input);
      },
    };
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: retryingDatabasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 3,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
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

    expect(commitAttemptCount).toBe(2);
    expect(mockBuildPlugin.build).toHaveBeenCalledTimes(2);
    expect(mockCli.createTarBrTargetFiles).toHaveBeenCalledTimes(2);
    expect(mockStoragePlugin.put).toHaveBeenCalledTimes(6);
    expect(mockCli.p.log.success).toHaveBeenCalledTimes(2);
    expect(mockCli.p.outro).toHaveBeenCalledTimes(1);
    expect(mockCli.p.outro).toHaveBeenCalledWith(
      "🚀 Deployment Successful (iOS, Android)",
    );
    expect(
      (await databaseHarness.bundles()).map(({ id }) => id).sort(),
    ).toEqual(["bundle-android", "bundle-ios"]);
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

  it("uploads manifest artifacts and stores manifest metadata on the bundle", async () => {
    mockStoragePlugin.put.mockImplementation(async ({ key }) => {
      return {
        storageUri: `s3://bundles/${key}`,
      };
    });

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockStoragePlugin.put).toHaveBeenCalledTimes(3);
    expect((await databaseHarness.bundles())[0]).toMatchObject({
      assetBaseStorageUri: "s3://bundles/assets",
      manifestFileHash: "file-hash",
      manifestStorageUri: "s3://bundles/bundle-123/manifest.json",
      metadata: expect.objectContaining({
        app_version: "1.0",
      }),
    });
  });

  it("preserves canonical special-character base segments in derived asset URIs", async () => {
    mockStoragePlugin.put.mockImplementation(async ({ key }) => ({
      storageUri: createStorageUri({
        protocol: "s3",
        bucket: "bundles",
        key: `release root#100%/${key}`,
      }),
    }));

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect((await databaseHarness.bundles())[0]).toMatchObject({
      assetBaseStorageUri: "s3://bundles/release%20root%23100%25/assets",
      manifestStorageUri:
        "s3://bundles/release%20root%23100%25/bundle-123/manifest.json",
      storageUri:
        "s3://bundles/release%20root%23100%25/bundle-123/bundle.tar.br",
    });
    expect(mockStoragePlugin.exists).toHaveBeenCalledWith({
      storageUri:
        "s3://bundles/release%20root%23100%25/assets/sha256/fi/file-hash.bundle",
    });
  });

  it("limits concurrent manifest asset uploads", async () => {
    const assetFiles = Array.from({ length: 20 }, (_, index) => ({
      name: `assets/file-${index}.png`,
      path: `/mock/build/assets/file-${index}.png`,
    }));
    let activeAssetUploads = 0;
    let maxActiveAssetUploads = 0;

    vi.mocked(getBundleZipTargets).mockResolvedValue(assetFiles);
    vi.mocked(writeBundleManifest).mockImplementation(
      async ({ bundleId, targetFiles }) => ({
        manifest: {
          assets: Object.fromEntries(
            targetFiles.map((targetFile, index) => [
              targetFile.name,
              {
                fileHash: `file-hash-${index}`,
              },
            ]),
          ),
          bundleId,
        },
        manifestPath: "/mock/build/manifest.json",
      }),
    );
    mockStoragePlugin.put.mockImplementation(async ({ key }) => {
      if (key.startsWith("assets/sha256/fi/")) {
        activeAssetUploads += 1;
        maxActiveAssetUploads = Math.max(
          maxActiveAssetUploads,
          activeAssetUploads,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeAssetUploads -= 1;
      }

      return {
        storageUri: `s3://bundles/${key}`,
      };
    });

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockStoragePlugin.put).toHaveBeenCalledTimes(22);
    expect(maxActiveAssetUploads).toBeGreaterThan(1);
    expect(maxActiveAssetUploads).toBeLessThanOrEqual(8);
  });

  it("deduplicates content-addressed asset uploads with the same object key", async () => {
    vi.mocked(getBundleZipTargets).mockResolvedValue([
      {
        name: "assets/src/logo.png",
        path: "/mock/build/assets/src/logo.png",
      },
      {
        name: "assets/src/logo-copy.png",
        path: "/mock/build/assets/src/logo-copy.png",
      },
    ]);

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockStoragePlugin.exists).toHaveBeenCalledTimes(1);
    expect(mockStoragePlugin.exists).toHaveBeenCalledWith({
      storageUri: "s3://bundles/assets/sha256/fi/file-hash.png",
    });
    expect(mockStoragePlugin.put).toHaveBeenCalledTimes(3);
    expect(mockStoragePlugin.put).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "assets/sha256/fi/file-hash.png",
      }),
    );
  });

  it("skips content-addressed asset uploads that already exist", async () => {
    mockStoragePlugin.exists.mockImplementation(async ({ storageUri }) => ({
      exists: storageUri === "s3://bundles/assets/sha256/fi/file-hash.png",
    }));
    vi.mocked(getBundleZipTargets).mockResolvedValue([
      {
        name: "assets/src/logo.png",
        path: "/mock/build/assets/src/logo.png",
      },
    ]);

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockStoragePlugin.exists).toHaveBeenCalledWith({
      storageUri: "s3://bundles/assets/sha256/fi/file-hash.png",
    });
    expect(mockStoragePlugin.put).toHaveBeenCalledTimes(2);
    expect(mockStoragePlugin.put).not.toHaveBeenCalledWith(
      expect.objectContaining({
        key: "assets/sha256/fi/file-hash.png",
      }),
    );
  });

  it("ignores deploy upload cache config and checks remote existence", async () => {
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      cacheDir: "node_modules/.hot-updater",
      compressStrategy: "tar.br",
      database: databasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 3,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    vi.mocked(getBundleZipTargets).mockResolvedValue([
      {
        name: "assets/src/logo.png",
        path: "/mock/build/assets/src/logo.png",
      },
    ]);

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockStoragePlugin.exists).toHaveBeenCalledWith({
      storageUri: "s3://bundles/assets/sha256/fi/file-hash.png",
    });
    expect(fs.promises.readFile).not.toHaveBeenCalledWith(
      expect.stringContaining("deploy-upload-cache.json"),
      expect.anything(),
    );
    expect(fs.promises.writeFile).not.toHaveBeenCalledWith(
      expect.stringContaining("deploy-upload-cache.json"),
      expect.anything(),
    );
  });

  it("does not write a deploy upload cache when asset upload fails", async () => {
    mockStoragePlugin.put.mockImplementation(async ({ key }) => {
      if (key === "assets/sha256/fi/file-hash.png") {
        throw new Error("asset upload failed");
      }

      return { storageUri: "s3://bundles/bundle-123/bundle.tar.br" };
    });
    vi.mocked(getBundleZipTargets).mockResolvedValue([
      {
        name: "assets/src/logo.png",
        path: "/mock/build/assets/src/logo.png",
      },
    ]);

    await expect(
      deploy({
        channel: "production",
        forceUpdate: false,
        interactive: false,
        platform: "ios",
        targetAppVersion: "1.0.x",
      }),
    ).rejects.toThrow("process.exit unexpectedly called");

    expect(mockCli.p.log.error).toHaveBeenCalledWith("asset upload failed");
    expect(fs.promises.writeFile).not.toHaveBeenCalledWith(
      expect.stringContaining("deploy-upload-cache.json"),
      expect.anything(),
    );
  });

  it("reports upload progress through 100%", async () => {
    const uploadMessages: string[] = [];

    mockCli.p.tasks.mockImplementation(async (tasks) => {
      for (const task of tasks) {
        await task.task((message: string) => {
          uploadMessages.push(message);
        });
      }
    });

    vi.mocked(getBundleZipTargets).mockResolvedValue([
      {
        name: "index.bundle",
        path: "/mock/build/index.bundle",
      },
      {
        name: "assets/src/logo.png",
        path: "/mock/build/assets/src/logo.png",
      },
    ]);

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(uploadMessages).toContain("Uploading 0% (0/4)");
    expect(uploadMessages).toContain("Uploading 25% (1/4)");
    expect(uploadMessages).toContain("Uploading 50% (2/4)");
    expect(uploadMessages).toContain("Uploading 75% (3/4)");
    expect(uploadMessages).toContain("Uploading 100% (4/4)");
  });

  it("uploads hermes bundle artifacts using the manifest filename", async () => {
    vi.mocked(getBundleZipTargets).mockResolvedValue([
      {
        name: "index.ios.bundle",
        path: "/mock/build/index.ios.bundle.hbc",
      },
      {
        name: "assets/src/logo.png",
        path: "/mock/build/assets/src/logo.png",
      },
    ]);

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockStoragePlugin.put).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "assets/sha256/fi/file-hash.br",
      }),
    );
    expect(mockStoragePlugin.put).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "assets/sha256/fi/file-hash.png",
      }),
    );
  });

  it("does not create a nested spinner when signing is enabled", async () => {
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: databasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 3,
      },
      signing: { enabled: true, privateKeyPath: "/mock/private.pem" },
      storage: mockStoragePlugin,
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

  it("creates automatic partial update paths when patch generation is enabled", async () => {
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: databasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 2,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    await mockGetBundlesWithFixtures([
      { id: fixtureBundleId(122), targetAppVersion: "1.0.x" },
      { id: fixtureBundleId(121), targetAppVersion: "1.0.x" },
    ]);

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockServer.createBundleDiff).toHaveBeenNthCalledWith(
      1,
      {
        baseBundleId: fixtureBundleId(122),
        bundleId: DEPLOY_BUNDLE_ID,
      },
      {
        databasePlugin,
        storagePlugin: mockStoragePlugin,
      },
      {
        makePrimary: true,
      },
    );
    expect(mockServer.createBundleDiff).toHaveBeenNthCalledWith(
      2,
      {
        baseBundleId: fixtureBundleId(121),
        bundleId: DEPLOY_BUNDLE_ID,
      },
      {
        databasePlugin,
        storagePlugin: mockStoragePlugin,
      },
      {
        makePrimary: false,
      },
    );
  });

  it("creates an automatic patch when target app versions are semver-compatible but not exact", async () => {
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: databasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 1,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    await mockGetBundlesWithFixtures([
      {
        id: fixtureBundleId(122),
        targetAppVersion: "1.1.0",
      },
    ]);

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.1",
    });

    expect(mockServer.createBundleDiff).toHaveBeenCalledWith(
      {
        baseBundleId: fixtureBundleId(122),
        bundleId: DEPLOY_BUNDLE_ID,
      },
      {
        databasePlugin,
        storagePlugin: mockStoragePlugin,
      },
      {
        makePrimary: true,
      },
    );
  });

  it("does not create an automatic patch when a prerelease target is outside the base range", async () => {
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: databasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 1,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    await mockGetBundlesWithFixtures([
      {
        id: fixtureBundleId(122),
        targetAppVersion: "1.x",
      },
    ]);

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.2.3-a",
    });

    expect(mockServer.createBundleDiff).not.toHaveBeenCalled();
  });

  it("scans past incompatible appVersion patch bases to find an older compatible base", async () => {
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: databasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 1,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    await mockGetBundlesWithFixtures([
      ...Array.from({ length: 10 }, (_, index) => ({
        id: fixtureBundleId(122 - index),
        targetAppVersion: "1.0.0",
      })),
      {
        id: fixtureBundleId(112),
        targetAppVersion: "1.1.0",
      },
    ]);

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.1",
    });

    expect(mockServer.createBundleDiff).toHaveBeenCalledWith(
      {
        baseBundleId: fixtureBundleId(112),
        bundleId: DEPLOY_BUNDLE_ID,
      },
      {
        databasePlugin,
        storagePlugin: mockStoragePlugin,
      },
      {
        makePrimary: true,
      },
    );
  });

  it("keeps deploy successful when automatic patch generation fails", async () => {
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: databasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 1,
      },
      signing: { enabled: false },
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    await mockGetBundlesWithFixtures([
      { id: fixtureBundleId(122), targetAppVersion: "1.0.x" },
    ]);
    mockServer.createBundleDiff.mockRejectedValueOnce(
      new Error("storage unavailable"),
    );

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(mockCli.p.outro).toHaveBeenCalledWith(
      `🚀 Deployment Successful (${DEPLOY_BUNDLE_ID})`,
    );
    expect(mockCli.p.log.warn).toHaveBeenCalledWith(
      `Partial update skipped for ${fixtureBundleId(122).slice(0, 8)}: storage unavailable`,
    );
  });

  it("falls back to the auto-detected target app version in non-interactive mode when -t is omitted", async () => {
    vi.mocked(getDefaultTargetAppVersion).mockResolvedValue("1.5.0");

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
    });

    expect((await databaseHarness.releases())[0]).toMatchObject({
      target_app_version: "1.5.0",
    });
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
    expect(await databaseHarness.bundles()).toEqual([]);
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

    expect((await databaseHarness.releases())[0]).toMatchObject({
      target_app_version: "1.2.0",
    });
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
    expect((await databaseHarness.releases())[0]).toMatchObject({
      target_app_version: "1.7.0",
    });
  });
});
