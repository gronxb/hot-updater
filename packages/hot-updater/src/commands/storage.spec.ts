import fs from "node:fs/promises";

import type { Bundle, StorageObject } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCli,
  mockDatabasePlugin,
  mockPrintBanner,
  mockStorageNode,
  mockStoragePlugin,
} = vi.hoisted(() => {
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
  const mockStorageNode = {
    delete: vi.fn(),
    deleteObjects: vi.fn(),
    downloadFile: vi.fn(),
    exists: vi.fn(),
    listObjects: vi.fn(),
    upload: vi.fn(),
  };
  const mockStoragePlugin = {
    name: "s3Storage",
    profiles: { node: mockStorageNode },
    supportedProtocol: "s3",
  };
  const mockCli = {
    loadConfig: vi.fn(),
    p: {
      log: {
        error: vi.fn(),
        info: vi.fn(),
        message: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
      },
    },
  };

  return {
    mockCli,
    mockDatabasePlugin,
    mockPrintBanner: vi.fn(),
    mockStorageNode,
    mockStoragePlugin,
  };
});

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    loadConfig: mockCli.loadConfig,
    p: mockCli.p,
  };
});

vi.mock("@/utils/printBanner", () => ({
  printBanner: mockPrintBanner,
}));

const LIVE_BUNDLE_ID = "0195a408-8f13-7d9b-8df4-123456789abc";
const DEAD_BUNDLE_ID = "0195a408-8f13-7d9b-8df4-123456789abd";
const IMAGE_HASH = "a".repeat(64);
const BUNDLE_HASH = "b".repeat(64);
const ORPHAN_HASH = "c".repeat(64);
const YOUNG_ORPHAN_HASH = "d".repeat(64);

const liveBundle: Bundle = {
  assetBaseStorageUri: "s3://bucket/assets",
  channel: "production",
  enabled: true,
  fileHash: "archive-hash",
  fingerprintHash: null,
  gitCommitHash: null,
  id: LIVE_BUNDLE_ID,
  manifestStorageUri: `s3://bucket/${LIVE_BUNDLE_ID}/manifest.json`,
  message: null,
  platform: "ios",
  rolloutCohortCount: 1000,
  shouldForceUpdate: false,
  storageUri: `s3://bucket/${LIVE_BUNDLE_ID}/bundle.zip`,
  targetAppVersion: "1.0.0",
  targetCohorts: null,
};

const object = (
  key: string,
  lastModifiedAt: Date,
  size = 10,
): StorageObject => ({
  key,
  lastModifiedAt,
  size,
  storageUri: `s3://bucket/${key}`,
});

describe("parseStoragePruneMinAge", () => {
  it("parses minute, hour, day, and week durations", async () => {
    const { parseStoragePruneMinAge } = await import("./storage");

    expect(parseStoragePruneMinAge("30m")).toBe(30 * 60 * 1000);
    expect(parseStoragePruneMinAge("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseStoragePruneMinAge("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseStoragePruneMinAge("2w")).toBe(14 * 24 * 60 * 60 * 1000);
    expect(() => parseStoragePruneMinAge("tomorrow")).toThrow(
      "must use a duration",
    );
  });
});

describe("handleStoragePrune", () => {
  const now = new Date("2026-08-13T00:00:00.000Z");
  const old = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const young = new Date(now.getTime() - 60 * 60 * 1000);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);

    mockCli.loadConfig.mockResolvedValue({
      database: vi.fn().mockResolvedValue(mockDatabasePlugin),
      storage: vi.fn().mockResolvedValue(mockStoragePlugin),
    });
    mockDatabasePlugin.getBundles.mockResolvedValue({
      data: [liveBundle],
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: 1,
        totalPages: 1,
      },
    });
    mockStorageNode.downloadFile.mockImplementation(
      async (_storageUri: string, filePath: string) => {
        await fs.writeFile(
          filePath,
          JSON.stringify({
            assets: {
              "images/logo.png": { fileHash: IMAGE_HASH },
              "index.ios.bundle": { fileHash: BUNDLE_HASH },
            },
          }),
        );
      },
    );
    mockStorageNode.listObjects.mockResolvedValue([
      object(`assets/sha256/${IMAGE_HASH.slice(0, 2)}/${IMAGE_HASH}.png`, old),
      object(`assets/sha256/${BUNDLE_HASH.slice(0, 2)}/${BUNDLE_HASH}.br`, old),
      object(
        `assets/sha256/${ORPHAN_HASH.slice(0, 2)}/${ORPHAN_HASH}.png`,
        old,
        30,
      ),
      object(
        `assets/sha256/${YOUNG_ORPHAN_HASH.slice(0, 2)}/${YOUNG_ORPHAN_HASH}.png`,
        young,
      ),
      object(`${LIVE_BUNDLE_ID}/bundle.zip`, old),
      object(`${DEAD_BUNDLE_ID}/bundle.zip`, old, 40),
      object(`${DEAD_BUNDLE_ID}/files/logo.png`, old, 20),
      object(`bundles/${LIVE_BUNDLE_ID}/manifest.json`, old),
      object(`bundles/${DEAD_BUNDLE_ID}/manifest.json`, old, 50),
      object("production/ios/1.0.0/update.json", old),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("deletes only old unreferenced assets and orphaned bundle storage", async () => {
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.deleteObjects).toHaveBeenCalledOnce();
    expect(mockStorageNode.deleteObjects).toHaveBeenCalledWith([
      `s3://bucket/assets/sha256/${ORPHAN_HASH.slice(0, 2)}/${ORPHAN_HASH}.png`,
      `s3://bucket/${DEAD_BUNDLE_ID}/bundle.zip`,
      `s3://bucket/${DEAD_BUNDLE_ID}/files/logo.png`,
      `s3://bucket/bundles/${DEAD_BUNDLE_ID}/manifest.json`,
    ]);
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      "Pruned 4 objects (140 B).",
    );
    expect(mockDatabasePlugin.onUnmount).toHaveBeenCalledOnce();
  });

  it("reports candidates without deleting when --yes is omitted", async () => {
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune();

    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
    expect(mockCli.p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Dry run only"),
    );
  });

  it("rechecks manifest references before deleting", async () => {
    let manifestReadCount = 0;
    mockStorageNode.downloadFile.mockImplementation(
      async (_storageUri: string, filePath: string) => {
        manifestReadCount += 1;
        await fs.writeFile(
          filePath,
          JSON.stringify({
            assets: {
              "images/logo.png": { fileHash: IMAGE_HASH },
              "index.ios.bundle": { fileHash: BUNDLE_HASH },
              ...(manifestReadCount > 1
                ? { "images/restored.png": { fileHash: ORPHAN_HASH } }
                : {}),
            },
          }),
        );
      },
    );
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.deleteObjects).toHaveBeenCalledWith([
      `s3://bucket/${DEAD_BUNDLE_ID}/bundle.zip`,
      `s3://bucket/${DEAD_BUNDLE_ID}/files/logo.png`,
      `s3://bucket/bundles/${DEAD_BUNDLE_ID}/manifest.json`,
    ]);
  });

  it("aborts before listing or deletion when a live manifest cannot be read", async () => {
    mockStorageNode.downloadFile.mockRejectedValueOnce(
      new Error("manifest missing"),
    );
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune({ yes: true })).rejects.toThrow(
      `failed to read manifest for bundle ${LIVE_BUNDLE_ID}`,
    );

    expect(mockStorageNode.listObjects).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
    expect(mockDatabasePlugin.onUnmount).toHaveBeenCalledOnce();
  });

  it("reports when the configured storage plugin cannot enumerate objects", async () => {
    mockCli.loadConfig.mockResolvedValue({
      database: vi.fn().mockResolvedValue(mockDatabasePlugin),
      storage: vi.fn().mockResolvedValue({
        ...mockStoragePlugin,
        name: "unsupportedStorage",
        profiles: {
          node: {
            ...mockStorageNode,
            listObjects: undefined,
          },
        },
      }),
    });
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune()).rejects.toThrow(
      'Storage plugin "unsupportedStorage" does not support storage prune.',
    );

    expect(mockStorageNode.downloadFile).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
    expect(mockDatabasePlugin.onUnmount).toHaveBeenCalledOnce();
  });
});
