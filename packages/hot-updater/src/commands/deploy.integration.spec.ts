import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Bundle } from "@hot-updater/core";
import type {
  BuildPlugin,
  ConfigInput,
  DatabasePlugin,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCwd = vi.fn();
const mockLoadConfig = vi.fn();
const mockGetLatestGitCommit = vi.fn();
const mockGetDefaultTargetAppVersion = vi.fn();
const mockGetNativeAppVersion = vi.fn();
const mockValidateSigningConfig = vi.fn();

const mockTasks = vi.fn(
  async (
    tasks: Array<{
      task: () => Promise<string>;
    }>,
  ) => {
    for (const item of tasks) {
      await item.task();
    }
  },
);

vi.mock("@hot-updater/cli-tools", () => ({
  getCwd: mockGetCwd,
  loadConfig: mockLoadConfig,
  p: {
    isCancel: vi.fn(() => false),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      error: vi.fn(),
    })),
    log: {
      step: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    tasks: mockTasks,
    note: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(false),
    text: vi.fn(),
  },
}));

vi.mock("@/utils/printBanner", () => ({
  printBanner: vi.fn(),
}));

vi.mock("@/utils/git", () => ({
  appendToProjectRootGitignore: vi.fn(() => false),
  getLatestGitCommit: mockGetLatestGitCommit,
}));

vi.mock("@/utils/version/getDefaultTargetAppVersion", () => ({
  getDefaultTargetAppVersion: mockGetDefaultTargetAppVersion,
}));

vi.mock("@/utils/version/getNativeAppVersion", () => ({
  getNativeAppVersion: mockGetNativeAppVersion,
}));

vi.mock("@/utils/signing/validateSigningConfig", () => ({
  validateSigningConfig: mockValidateSigningConfig,
}));

vi.mock("./console", () => ({
  getConsolePort: vi.fn(),
  openConsole: vi.fn(),
}));

describe("deploy OTA v2 integration", () => {
  let rootDir = "";
  let buildDir = "";

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-deploy-it-"));
    buildDir = path.join(rootDir, "build");
    await fs.mkdir(path.join(buildDir, "assets"), { recursive: true });
  });

  afterEach(async () => {
    if (rootDir) {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("uploads files individually without compression and stores incremental manifest metadata", async () => {
    const bundleId = "00000000-0000-0000-0000-000000001111";
    const hbcBytes = Buffer.from("hermes-bytecode-v2");
    const legacyBundleBytes = Buffer.from("legacy-bundle-file");
    const assetBytes = Buffer.from("asset-image-data");

    await fs.writeFile(path.join(buildDir, "index.android.bundle.hbc"), hbcBytes);
    await fs.writeFile(
      path.join(buildDir, "index.android.bundle"),
      legacyBundleBytes,
    );
    await fs.writeFile(
      path.join(buildDir, "index.android.bundle.map"),
      "source map",
    );
    await fs.writeFile(path.join(buildDir, "assets", "image.png"), assetBytes);

    const uploaded: Array<{
      key: string;
      filePath: string;
      storageUri: string;
    }> = [];
    const appendedBundles: Bundle[] = [];

    const buildPlugin: BuildPlugin = {
      name: "build-test",
      build: vi.fn().mockResolvedValue({
        buildPath: buildDir,
        bundleId,
        stdout: "ok",
      }),
    };

    const storagePlugin: StoragePlugin = {
      name: "storage-test",
      supportedProtocol: "memory",
      upload: vi.fn(async (key, filePath) => {
        const storageUri = `memory://bucket/${key}/${path.basename(filePath)}`;
        uploaded.push({ key, filePath, storageUri });
        return { storageUri };
      }),
      delete: vi.fn(),
      getDownloadUrl: vi.fn(),
    };

    const databasePlugin: DatabasePlugin = {
      name: "database-test",
      getChannels: vi.fn().mockResolvedValue([]),
      getBundleById: vi.fn().mockResolvedValue(null),
      getBundles: vi.fn().mockResolvedValue({
        data: [],
        pagination: {
          total: 0,
          hasNextPage: false,
          hasPreviousPage: false,
          currentPage: 1,
          totalPages: 1,
        },
      }),
      updateBundle: vi.fn(),
      appendBundle: vi.fn(async (bundle) => {
        appendedBundles.push(bundle);
      }),
      commitBundle: vi.fn(),
      deleteBundle: vi.fn(),
      onUnmount: vi.fn(),
    };

    const config: ConfigInput = {
      updateStrategy: "appVersion",
      compressStrategy: "zip",
      build: () => buildPlugin,
      storage: () => storagePlugin,
      database: () => databasePlugin,
      signing: { enabled: false },
    };

    mockGetCwd.mockReturnValue(rootDir);
    mockLoadConfig.mockResolvedValue(config);
    mockGetLatestGitCommit.mockResolvedValue(null);
    mockGetDefaultTargetAppVersion.mockResolvedValue("1.0.0");
    mockGetNativeAppVersion.mockResolvedValue("2.3.4");
    mockValidateSigningConfig.mockResolvedValue({ issues: [] });

    const { deploy } = await import("./deploy");

    await deploy({
      channel: "production",
      forceUpdate: false,
      interactive: false,
      platform: "android",
      targetAppVersion: "1.0.0",
    });

    expect(uploaded.length).toBe(2);
    expect(
      uploaded.some((item) => item.filePath.endsWith("index.android.bundle")),
    ).toBe(true);
    expect(
      uploaded.some((item) => item.filePath.endsWith("index.android.bundle.hbc")),
    ).toBe(false);
    expect(
      uploaded.some((item) =>
        item.filePath.match(/\.(zip|tar|gz|br)$/),
      ),
    ).toBe(false);

    expect(appendedBundles).toHaveLength(1);
    const inserted = appendedBundles[0];
    expect(inserted).toBeDefined();
    if (!inserted) {
      throw new Error("inserted bundle not found");
    }
    const expectedBundleHash = createHash("sha256").update(hbcBytes).digest("hex");

    expect(inserted.fileHash).toBe(expectedBundleHash);
    expect(inserted.storageUri).toBe(
      `memory://bucket/${bundleId}/index.android.bundle`,
    );
    expect(inserted.metadata?.app_version).toBe("2.3.4");
    expect(inserted.metadata?.incremental?.bundleHash).toBe(expectedBundleHash);
    expect(inserted.metadata?.incremental?.patchCache).toEqual({});
    expect(inserted.metadata?.incremental?.manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "index.android.bundle",
          hash: expectedBundleHash,
          kind: "bundle",
          size: hbcBytes.length,
        }),
        expect.objectContaining({
          path: "assets/image.png",
          hash: createHash("sha256").update(assetBytes).digest("hex"),
          kind: "asset",
          size: assetBytes.length,
        }),
      ]),
    );
  });
});
