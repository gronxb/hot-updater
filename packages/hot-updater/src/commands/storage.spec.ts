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
    dispose: vi.fn(),
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

vi.mock("@hot-updater/plugin-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/plugin-core")>();
  return {
    ...actual,
    createDatabaseClient: vi.fn(() => mockDatabasePlugin),
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

describe("parseStoragePruneProtection", () => {
  it("parses minute, hour, day, and week durations", async () => {
    const { parseStoragePruneProtection } = await import("./storage");

    expect(parseStoragePruneProtection("30m")).toBe(30 * 60 * 1000);
    expect(parseStoragePruneProtection("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseStoragePruneProtection("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseStoragePruneProtection("2w")).toBe(14 * 24 * 60 * 60 * 1000);
    expect(() => parseStoragePruneProtection("tomorrow")).toThrow(
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
    mockDatabasePlugin.name = "mock-database";

    mockCli.loadConfig.mockResolvedValue({
      database: mockDatabasePlugin,
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
            bundleId: LIVE_BUNDLE_ID,
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
    vi.unstubAllGlobals();
  });

  it("deletes only old unreferenced assets and orphaned bundle storage", async () => {
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.deleteObjects).toHaveBeenCalledOnce();
    expect(mockStorageNode.deleteObjects).toHaveBeenCalledWith([
      `assets/sha256/${ORPHAN_HASH.slice(0, 2)}/${ORPHAN_HASH}.png`,
      `${DEAD_BUNDLE_ID}/bundle.zip`,
      `${DEAD_BUNDLE_ID}/files/logo.png`,
      `bundles/${DEAD_BUNDLE_ID}/manifest.json`,
    ]);
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      "Pruned 4 objects (140 B).",
    );
    expect(mockCli.p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("requires exclusive access"),
    );
    expect(mockCli.p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("separate storage basePath"),
    );
    expect(mockDatabasePlugin.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "by default", options: {} },
    { label: "with --dry-run", options: { dryRun: true } },
  ])("reports candidates without deleting $label", async ({ options }) => {
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune(options);

    const output = mockCli.p.log.message.mock.calls
      .map(([message]) => String(message))
      .join("\n");
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
    expect(output).toContain(
      `assets/sha256/${ORPHAN_HASH.slice(0, 2)}/${ORPHAN_HASH}.png`,
    );
    expect(output).toContain(`${DEAD_BUNDLE_ID}/bundle.zip`);
    expect(output).toContain(`${DEAD_BUNDLE_ID}/files/logo.png`);
    expect(output).toContain(`bundles/${DEAD_BUNDLE_ID}/manifest.json`);
    expect(output).toContain("shared asset");
    expect(output).toContain("bundle data");
    expect(output).toContain("30 B");
    expect(output).toContain(old.toISOString());
    expect(output).not.toContain(YOUNG_ORPHAN_HASH);
    expect(output).not.toContain(`${LIVE_BUNDLE_ID}/bundle.zip`);
    expect(mockCli.p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Dry run only"),
    );
  });

  it("protects unreferenced objects modified within the configured window", async () => {
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({
      protectNewerThan: 3 * 24 * 60 * 60 * 1000,
      yes: true,
    });

    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      "No objects are eligible for pruning.",
    );
  });

  it("preserves the protection window in the suggested delete command", async () => {
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({
      dryRun: true,
      protectNewerThan: 24 * 60 * 60 * 1000,
    });

    expect(mockCli.p.log.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "hot-updater storage prune --protect-newer-than 1d --yes",
      ),
    );
  });

  it("rejects conflicting dry-run and deletion options before loading config", async () => {
    const { handleStoragePrune } = await import("./storage");

    await expect(
      handleStoragePrune({ dryRun: true, yes: true }),
    ).rejects.toThrow("--dry-run cannot be used with --yes");
    expect(mockCli.loadConfig).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("rechecks manifest references before deleting", async () => {
    let manifestReadCount = 0;
    mockStorageNode.downloadFile.mockImplementation(
      async (_storageUri: string, filePath: string) => {
        manifestReadCount += 1;
        await fs.writeFile(
          filePath,
          JSON.stringify({
            bundleId: LIVE_BUNDLE_ID,
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
      `${DEAD_BUNDLE_ID}/bundle.zip`,
      `${DEAD_BUNDLE_ID}/files/logo.png`,
      `bundles/${DEAD_BUNDLE_ID}/manifest.json`,
    ]);
  });

  it("does not delete when the final reference scan fails", async () => {
    let manifestReadCount = 0;
    mockStorageNode.downloadFile.mockImplementation(
      async (_storageUri: string, filePath: string) => {
        manifestReadCount += 1;
        if (manifestReadCount > 1) {
          throw new Error("manifest unavailable");
        }
        await fs.writeFile(
          filePath,
          JSON.stringify({
            bundleId: LIVE_BUNDLE_ID,
            assets: {
              "images/logo.png": { fileHash: IMAGE_HASH },
              "index.ios.bundle": { fileHash: BUNDLE_HASH },
            },
          }),
        );
      },
    );
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune({ yes: true })).rejects.toThrow(
      `failed to read manifest for bundle ${LIVE_BUNDLE_ID}`,
    );
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("protects metadata stored below a UUID-shaped channel", async () => {
    const uuidChannelMetadata = `${DEAD_BUNDLE_ID}/ios/1.0.0/update.json`;
    mockStorageNode.listObjects.mockResolvedValue([
      object(uuidChannelMetadata, old),
      object(`${DEAD_BUNDLE_ID}/bundle.zip`, old),
    ]);
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.deleteObjects).toHaveBeenCalledWith([
      `${DEAD_BUNDLE_ID}/bundle.zip`,
    ]);
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalledWith(
      expect.arrayContaining([uuidChannelMetadata]),
    );
  });

  it("fails closed when the asset base uses another storage protocol", async () => {
    mockDatabasePlugin.getBundles.mockResolvedValue({
      data: [
        {
          ...liveBundle,
          assetBaseStorageUri: "https://cdn.example.com/assets",
        },
      ],
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: 1,
        totalPages: 1,
      },
    });
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune({ yes: true })).rejects.toThrow(
      "uses https asset storage",
    );
    expect(mockStorageNode.listObjects).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("allows an HTTP manifest when shared assets use the configured storage", async () => {
    mockDatabasePlugin.getBundles.mockResolvedValue({
      data: [
        {
          ...liveBundle,
          manifestStorageUri: "https://cdn.example.com/manifest.json",
        },
      ],
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: 1,
        totalPages: 1,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () =>
          JSON.stringify({
            bundleId: LIVE_BUNDLE_ID,
            assets: {
              "images/logo.png": { fileHash: IMAGE_HASH },
              "index.ios.bundle": { fileHash: BUNDLE_HASH },
            },
          }),
      })),
    );
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(fetch).toHaveBeenCalledWith("https://cdn.example.com/manifest.json");
    expect(mockStorageNode.deleteObjects).toHaveBeenCalled();
  });

  it("fails closed when a manifest belongs to another bundle", async () => {
    mockStorageNode.downloadFile.mockImplementation(
      async (_storageUri: string, filePath: string) => {
        await fs.writeFile(
          filePath,
          JSON.stringify({
            bundleId: DEAD_BUNDLE_ID,
            assets: {
              "images/logo.png": { fileHash: IMAGE_HASH },
            },
          }),
        );
      },
    );
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune({ yes: true })).rejects.toThrow(
      `invalid manifest for bundle ${LIVE_BUNDLE_ID}`,
    );
    expect(mockStorageNode.listObjects).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("fails closed when a manifest contains a malformed asset hash", async () => {
    mockStorageNode.downloadFile.mockImplementation(
      async (_storageUri: string, filePath: string) => {
        await fs.writeFile(
          filePath,
          JSON.stringify({
            bundleId: LIVE_BUNDLE_ID,
            assets: {
              "images/logo.png": { fileHash: "not-a-sha256" },
            },
          }),
        );
      },
    );
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune({ yes: true })).rejects.toThrow(
      `invalid manifest for bundle ${LIVE_BUNDLE_ID}`,
    );
    expect(mockStorageNode.listObjects).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("fails closed when the database omits a required next cursor", async () => {
    mockDatabasePlugin.getBundles.mockResolvedValue({
      data: [liveBundle],
      pagination: {
        currentPage: 1,
        hasNextPage: true,
        hasPreviousPage: false,
        nextCursor: null,
        total: 10_001,
        totalPages: 2,
      },
    });
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune({ yes: true })).rejects.toThrow(
      "cannot provide safe cursor pagination",
    );
    expect(mockStorageNode.downloadFile).not.toHaveBeenCalled();
    expect(mockStorageNode.listObjects).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("loads standalone references in pages within the server limit", async () => {
    mockDatabasePlugin.name = "standalone-repository";
    mockDatabasePlugin.getBundles.mockImplementation(
      async (options: { cursor?: { after: string }; limit: number }) => {
        if (options.limit > 100) {
          throw new Error("limit must be less than or equal to 100");
        }
        if (!options.cursor) {
          return {
            data: [liveBundle],
            pagination: {
              hasNextPage: true,
              nextCursor: "page-2",
            },
          };
        }
        return {
          data: [],
          pagination: { hasNextPage: false, nextCursor: null },
        };
      },
    );
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ dryRun: true });

    expect(mockDatabasePlugin.getBundles).toHaveBeenCalledTimes(2);
    expect(mockDatabasePlugin.getBundles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cursor: undefined, limit: 100 }),
    );
    expect(mockDatabasePlugin.getBundles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: { after: "page-2" },
        limit: 100,
      }),
    );
  });

  it("protects exact and legacy-prefix URIs referenced by live bundles", async () => {
    const referencedLegacyId = DEAD_BUNDLE_ID;
    mockDatabasePlugin.getBundles.mockResolvedValue({
      data: [
        {
          ...liveBundle,
          assetBaseStorageUri: `s3://bucket/${referencedLegacyId}/files`,
          manifestStorageUri: `s3://bucket/${referencedLegacyId}/manifest.json`,
          storageUri: `s3://bucket/${referencedLegacyId}/bundle.zip`,
        },
      ],
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: 1,
        totalPages: 1,
      },
    });
    mockStorageNode.listObjects.mockResolvedValue([
      object(`${referencedLegacyId}/bundle.zip`, old),
      object(`${referencedLegacyId}/manifest.json`, old),
      object(`${referencedLegacyId}/files/logo.png`, old),
    ]);
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.downloadFile).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
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
    expect(mockDatabasePlugin.dispose).toHaveBeenCalledOnce();
  });

  it("reports when the configured storage plugin cannot enumerate objects", async () => {
    mockCli.loadConfig.mockResolvedValue({
      database: mockDatabasePlugin,
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
    expect(mockDatabasePlugin.dispose).toHaveBeenCalledOnce();
  });
});
