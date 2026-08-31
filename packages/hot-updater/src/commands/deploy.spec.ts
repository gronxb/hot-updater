import { pipeline } from "stream/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockBuildPlugin, mockCli, mockServer, mockStoragePlugin } = vi.hoisted(
  () => {
    const mockBuildPlugin = {
      build: vi.fn(),
      name: "mock-build",
      nativeBuild: undefined as
        | {
            getBundleSigningPublicKey: ReturnType<typeof vi.fn>;
            getFingerprintExtraSources?: ReturnType<typeof vi.fn>;
          }
        | undefined,
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
      getStorageFileByteSize: vi.fn(),
      loadConfig: vi.fn(),
      p: {
        confirm: vi.fn(),
        isCancel: vi.fn(),
        log: {
          error: vi.fn(),
          info: vi.fn(),
          message: vi.fn(),
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
      prepareBundleSigning: vi.fn(),
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
      blue: (value: string) => value,
      blueBright: (value: string) => value,
      bold: (value: string) => value,
      cyan: (value: string) => value,
      dim: (value: string) => value,
      green: (value: string) => value,
      magenta: (value: string) => value,
      red: (value: string) => value,
      underline: (value: string) => value,
      yellow: (value: string) => value,
    },
    createTarBrTargetFiles: mockCli.createTarBrTargetFiles,
    createTarGzTargetFiles: mockCli.createTarGzTargetFiles,
    createZipTargetFiles: mockCli.createZipTargetFiles,
    getCwd: mockCli.getCwd,
    getStorageFileByteSize: mockCli.getStorageFileByteSize,
    loadConfig: mockCli.loadConfig,
    p: mockCli.p,
    prepareBundleSigning: mockCli.prepareBundleSigning,
    putStorageFile: async (
      storage: typeof mockStoragePlugin,
      key: string,
      filePath: string,
    ) => {
      const result = await storage.put({
        key: [key, filePath.split("/").at(-1)!].filter(Boolean).join("/"),
        body: new Response("file").body!,
        contentLength: 4,
        contentType: "application/octet-stream",
      });
      return { ...result, byteSize: 4 };
    },
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
  createBundleManifest: vi.fn(),
  writeBundleManifestFile: vi.fn(),
}));

vi.mock("@/utils/fingerprint", () => ({
  appendFingerprintExtraSources: vi.fn((extraSources, additions) =>
    additions.length > 0
      ? [...(Array.isArray(extraSources) ? extraSources : []), ...additions]
      : extraSources,
  ),
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

import type { Bundle, DatabasePlugin } from "@hot-updater/plugin-core";
import {
  createStorageUri,
  DatabaseAtomicCommitUnsupportedError,
} from "@hot-updater/plugin-core";

import {
  createBundleManifest,
  writeBundleManifestFile,
} from "@/utils/bundleManifest";
import { getBundleZipTargets } from "@/utils/getBundleZipTargets";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { getLatestGitCommit } from "@/utils/git";
import { printBanner } from "@/utils/printBanner";
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
import type { DeployReleasePolicy } from "./deployTransaction";

interface DeploymentFixture {
  readonly bundle: Pick<Bundle, "id"> & Partial<Bundle>;
  readonly release?: Partial<DeployReleasePolicy>;
}

const fixtureBundleId = (sequence: number): string =>
  `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
const DEPLOY_BUNDLE_ID = fixtureBundleId(123);
const LOGICAL_FILE_HASH = "a".repeat(64);
const TRANSFER_FILE_HASH = "b".repeat(64);
const mockSigningPlugin = {
  getPublicKey: vi.fn(async () => ({ publicKey: "public-key" })),
  name: "mock-signing",
  sign: vi.fn(async () => ({ signature: new Uint8Array([1]) })),
};

const mockGetBundlesWithFixtures = (fixtures: DeploymentFixture[]) => {
  mockBuildPlugin.build.mockResolvedValue({
    buildPath: "/mock/build",
    bundleId: DEPLOY_BUNDLE_ID,
    stdout: null,
  });
  mockServer.createBundleDiff.mockResolvedValue({ id: DEPLOY_BUNDLE_ID });
  return databaseHarness.seedDeployments(
    fixtures.map((fixture) => ({
      bundle: {
        archiveByteSize: 1024,
        fileHash: "fixture-hash",
        gitCommitHash: null,
        platform: "ios",
        storageUri: `storage://${fixture.bundle.id}`,
        ...fixture.bundle,
      },
      release: {
        channel: "production",
        enabled: true,
        fingerprintHash: null,
        message: null,
        rolloutCohortCount: 1000,
        shouldForceUpdate: false,
        targetAppVersion: null,
        ...fixture.release,
      },
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
    mockBuildPlugin.nativeBuild = undefined;
    mockStoragePlugin.put.mockImplementation(async ({ key }) => ({
      storageUri: `s3://bundles/${key}`,
    }));
    mockStoragePlugin.exists.mockResolvedValue({ exists: false });
    mockServer.createBundleDiff.mockResolvedValue({
      id: "bundle-123",
    });
    mockCli.prepareBundleSigning.mockResolvedValue(null);

    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: databasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 3,
      },
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
    mockCli.getStorageFileByteSize.mockResolvedValue(4);
    vi.mocked(createBundleManifest).mockImplementation(
      async ({ bundleId, targetFiles }) => ({
        assets: Object.fromEntries(
          targetFiles.map((targetFile) => [
            targetFile.name,
            {
              fileHash: LOGICAL_FILE_HASH,
            },
          ]),
        ),
        bundleId,
      }),
    );
    vi.mocked(writeBundleManifestFile).mockResolvedValue(
      "/mock/build/manifest.json",
    );
    vi.mocked(getBundleZipTargets).mockResolvedValue([
      {
        name: "index.bundle",
        path: "/mock/build/index.bundle",
      },
    ]);
    vi.mocked(getFileHashFromFile).mockResolvedValue(TRANSFER_FILE_HASH);

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

  it("prints the committed Release identity with the deployment result", async () => {
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
    const release = (await databaseHarness.releases())[0]!;
    const catalog = await databasePlugin.models.releaseCatalogs.findByScopeKey(
      release.scope_key,
    );
    const summary = mockCli.p.log.message.mock.calls[0]?.[0];
    expect(summary).toContain("iOS Deployment");
    expect(summary).toContain(`Release ID:`);
    expect(summary).toContain(release.id);
    expect(summary).toContain(`Bundle ID:`);
    expect(summary).toContain("bundle-123");
    expect(summary).not.toContain("Authority ID:");
    expect(summary).not.toContain("Catalog ID:");
    expect(summary).not.toContain(catalog!.catalog_id);
    expect(summary).toContain(release.scope_key);
    expect(summary).toContain(`Generation:`);
    expect(summary).toContain(String(catalog?.generation));
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
    const releases = await databaseHarness.releases();
    for (const [platform, platformName, bundleId] of [
      ["ios", "iOS", "bundle-ios"],
      ["android", "Android", "bundle-android"],
    ] as const) {
      const release = releases.find(
        (candidate) =>
          candidate.platform === platform && candidate.bundle_id === bundleId,
      );
      expect(release).toBeDefined();
      const catalog =
        await databasePlugin.models.releaseCatalogs.findByScopeKey(
          release!.scope_key,
        );
      const summary = mockCli.p.log.message.mock.calls
        .map(([message]) => message)
        .find((message) => message.includes(`${platformName} Deployment`));
      expect(summary).toContain(release!.id);
      expect(summary).toContain(bundleId);
      expect(summary).not.toContain("Authority ID:");
      expect(summary).not.toContain("Catalog ID:");
      expect(summary).not.toContain(catalog!.catalog_id);
      expect(summary).toContain(release!.scope_key);
      expect(summary).toContain(String(catalog?.generation));
    }
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
      archiveByteSize: 4,
      manifestFileHash: TRANSFER_FILE_HASH,
      manifestStorageUri: "s3://bundles/bundles/bundle-123/manifest.json",
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
        "s3://bundles/release%20root%23100%25/bundles/bundle-123/manifest.json",
      storageUri:
        "s3://bundles/release%20root%23100%25/bundles/bundle-123/bundle.tar.br",
    });
    expect(mockStoragePlugin.exists).toHaveBeenCalledWith({
      storageUri: `s3://bundles/release%20root%23100%25/assets/sha256/aa/${LOGICAL_FILE_HASH}.bundle`,
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
    vi.mocked(createBundleManifest).mockImplementation(
      async ({ bundleId, targetFiles }) => ({
        assets: Object.fromEntries(
          targetFiles.map((targetFile, index) => [
            targetFile.name,
            {
              fileHash: (index + 1).toString(16).padStart(64, "0"),
            },
          ]),
        ),
        bundleId,
      }),
    );
    mockStoragePlugin.put.mockImplementation(async ({ key }) => {
      if (key.startsWith("assets/sha256/00/")) {
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
      storageUri: `s3://bundles/assets/sha256/aa/${LOGICAL_FILE_HASH}.png`,
    });
    expect(mockStoragePlugin.put).toHaveBeenCalledTimes(3);
    expect(mockStoragePlugin.put).toHaveBeenCalledWith(
      expect.objectContaining({
        key: `assets/sha256/aa/${LOGICAL_FILE_HASH}.png`,
      }),
    );
  });

  it("skips content-addressed asset uploads that already exist", async () => {
    mockStoragePlugin.exists.mockImplementation(async ({ storageUri }) => ({
      exists:
        storageUri === `s3://bundles/assets/sha256/aa/${LOGICAL_FILE_HASH}.png`,
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
      storageUri: `s3://bundles/assets/sha256/aa/${LOGICAL_FILE_HASH}.png`,
    });
    expect(mockStoragePlugin.put).toHaveBeenCalledTimes(2);
    expect(mockStoragePlugin.put).not.toHaveBeenCalledWith(
      expect.objectContaining({
        key: `assets/sha256/aa/${LOGICAL_FILE_HASH}.png`,
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
      storageUri: `s3://bundles/assets/sha256/aa/${LOGICAL_FILE_HASH}.png`,
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
      if (key === `assets/sha256/aa/${LOGICAL_FILE_HASH}.png`) {
        throw new Error("asset upload failed");
      }

      return {
        storageUri: "s3://bundles/bundles/bundle-123/bundle.tar.br",
      };
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
        key: `assets/sha256/bb/${TRANSFER_FILE_HASH}.br`,
      }),
    );
    expect(mockStoragePlugin.put).toHaveBeenCalledWith(
      expect.objectContaining({
        key: `assets/sha256/aa/${LOGICAL_FILE_HASH}.png`,
      }),
    );
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(writeBundleManifestFile).toHaveBeenCalledWith({
      buildPath: "/mock/build",
      manifest: {
        assets: {
          "assets/src/logo.png": {
            downloadByteSize: 4,
            fileHash: LOGICAL_FILE_HASH,
          },
          "index.ios.bundle": {
            downloadByteSize: 4,
            downloadFileHash: TRANSFER_FILE_HASH,
            fileHash: LOGICAL_FILE_HASH,
          },
        },
        bundleId: "bundle-123",
      },
    });
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
      signing: mockSigningPlugin,
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    mockBuildPlugin.build.mockResolvedValue({
      buildPath: "/mock/build",
      bundleId: "bundle-123",
      stdout: "LLVM\nHermes",
    });
    const signFileHash = vi.fn(async () => "signature");
    mockCli.prepareBundleSigning.mockResolvedValue({
      name: "local-file",
      publicKey: "public-key",
      signFileHash,
    });

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(signFileHash).toHaveBeenCalledWith(TRANSFER_FILE_HASH);
    expect(validateSigningConfig).toHaveBeenCalledWith(expect.anything(), {
      expectedPublicKey: "public-key",
    });
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

  it("validates an Expo CNG trust anchor against the signing provider", async () => {
    const getBundleSigningPublicKey = vi.fn(async () => ({
      publicKey: "expo-public-key",
    }));
    mockBuildPlugin.nativeBuild = { getBundleSigningPublicKey };
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: databasePlugin,
      fingerprint: {},
      patch: { enabled: true, maxBaseBundles: 3 },
      signing: mockSigningPlugin,
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    mockCli.prepareBundleSigning.mockResolvedValue({
      name: "provider",
      publicKey: "provider-public-key",
      signFileHash: vi.fn(async () => "signature"),
    });

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    expect(getBundleSigningPublicKey).toHaveBeenCalledOnce();
    expect(validateSigningConfig).toHaveBeenCalledWith(expect.anything(), {
      expectedPublicKey: "provider-public-key",
      nativePublicKey: "expo-public-key",
    });
  });

  it("fails before build or upload when the signing provider cannot be prepared", async () => {
    mockCli.loadConfig.mockResolvedValue({
      build: async () => mockBuildPlugin,
      compressStrategy: "tar.br",
      database: databasePlugin,
      fingerprint: {},
      patch: {
        enabled: true,
        maxBaseBundles: 3,
      },
      signing: mockSigningPlugin,
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    mockCli.prepareBundleSigning.mockRejectedValue(
      new Error("Failed to resolve the bundle signing provider public key."),
    );

    await expect(
      deploy({
        channel: "production",
        forceUpdate: false,
        interactive: false,
        platform: "ios",
        targetAppVersion: "1.0.x",
      }),
    ).rejects.toThrow(
      "Failed to resolve the bundle signing provider public key.",
    );

    expect(mockBuildPlugin.build).not.toHaveBeenCalled();
    expect(mockStoragePlugin.put).not.toHaveBeenCalled();
    expect(await databaseHarness.releases()).toEqual([]);
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
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    await mockGetBundlesWithFixtures([
      {
        bundle: { id: fixtureBundleId(122) },
        release: { targetAppVersion: "1.0.x" },
      },
      {
        bundle: { id: fixtureBundleId(121) },
        release: { targetAppVersion: "1.0.x" },
      },
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
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    await mockGetBundlesWithFixtures([
      {
        bundle: { id: fixtureBundleId(122) },
        release: { targetAppVersion: "1.1.0" },
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
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    await mockGetBundlesWithFixtures([
      {
        bundle: { id: fixtureBundleId(122) },
        release: { targetAppVersion: "1.x" },
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
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    await mockGetBundlesWithFixtures([
      ...Array.from({ length: 10 }, (_, index) => ({
        bundle: { id: fixtureBundleId(122 - index) },
        release: { targetAppVersion: "1.0.0" },
      })),
      {
        bundle: { id: fixtureBundleId(112) },
        release: { targetAppVersion: "1.1.0" },
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
      storage: mockStoragePlugin,
      updateStrategy: "appVersion",
    });
    await mockGetBundlesWithFixtures([
      {
        bundle: { id: fixtureBundleId(122) },
        release: { targetAppVersion: "1.0.x" },
      },
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
