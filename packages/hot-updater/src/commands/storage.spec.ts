import {
  bundleToPatchRows,
  bundleToRow,
  type Bundle,
  type StorageObject,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCli,
  mockDatabase,
  mockPrintBanner,
  mockStorageNode,
  mockStoragePlugin,
} = vi.hoisted(() => {
  const mockDatabase = {
    /** The bundles each core page holds, in order. */
    bundlePages: vi.fn(),
    name: "mock-database",
    dispose: vi.fn(),
    core: { listBundles: vi.fn() },
  };
  const mockStorageNode = {
    delete: vi.fn(),
    deleteObjects: vi.fn(),
    exists: vi.fn(),
    get: vi.fn(),
    listObjects: vi.fn(),
    put: vi.fn(),
  };
  const mockStoragePlugin = {
    ...mockStorageNode,
    name: "s3Storage",
    protocol: "s3",
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
    mockDatabase,
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
const DOWNLOAD_HASH = "e".repeat(64);
const ORPHAN_PATCH_KEY = `bundles/${LIVE_BUNDLE_ID}/patches/${DEAD_BUNDLE_ID}/index.ios.bundle.bsdiff`;

const liveBundle: Bundle = {
  assetBaseStorageUri: "s3://bucket/assets",
  gitCommitHash: null,
  id: LIVE_BUNDLE_ID,
  manifestFileHash: "manifest-hash",
  manifestStorageUri: `s3://bucket/bundles/${LIVE_BUNDLE_ID}/manifest.json`,
  platform: "ios",
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

const bundlePage = (bundle: Bundle): Bundle[] => [bundle];

const liveBundleWithPatch: Bundle = {
  ...liveBundle,
  patches: [
    {
      baseBundleId: DEAD_BUNDLE_ID,
      baseFileHash: "base-hash",
      byteSize: 10,
      patchFileHash: "patch-hash",
      patchStorageUri: `s3://bucket/${ORPHAN_PATCH_KEY}`,
    },
  ],
};

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
    mockDatabase.name = "mock-database";

    mockCli.loadConfig.mockResolvedValue({
      database: mockDatabase,
      storage: mockStoragePlugin,
    });
    // Core's bundle pages, as rows, from the bundles `bundlePages` answers.
    mockDatabase.core.listBundles.mockImplementation(async (input: unknown) =>
      ((await mockDatabase.bundlePages(input)) as readonly Bundle[]).map(
        (bundle) => ({
          bundle: bundleToRow(bundle),
          patches: bundleToPatchRows(bundle),
          childCount: 0,
        }),
      ),
    );
    mockDatabase.bundlePages.mockResolvedValue([liveBundle]);
    mockStorageNode.get.mockImplementation(async () => ({
      response: new Response(
        JSON.stringify({
          bundleId: LIVE_BUNDLE_ID,
          assets: {
            "images/logo.png": { fileHash: IMAGE_HASH },
            "index.ios.bundle": { fileHash: BUNDLE_HASH },
          },
        }),
      ),
    }));
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
      object(`bundles/${LIVE_BUNDLE_ID}/bundle.tar.br`, old),
      object(`bundles/${DEAD_BUNDLE_ID}/bundle.tar.br`, old, 40),
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
      `bundles/${DEAD_BUNDLE_ID}/bundle.tar.br`,
      `bundles/${DEAD_BUNDLE_ID}/manifest.json`,
    ]);
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      "Pruned 3 objects (120 B).",
    );
    expect(mockCli.p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("requires exclusive access"),
    );
    const exclusiveWarning = String(mockCli.p.log.warn.mock.calls[0]?.[0]);
    expect(exclusiveWarning).toContain("deploy");
    expect(exclusiveWarning).toContain("patch");
    expect(exclusiveWarning).not.toContain("promote");
    expect(mockCli.p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("separate storage basePath"),
    );
    expect(mockDatabase.dispose).toHaveBeenCalledOnce();
  });

  it("preserves the exact transferred payload referenced by downloadFileHash", async () => {
    mockStorageNode.get.mockImplementation(async () => ({
      response: new Response(
        JSON.stringify({
          bundleId: LIVE_BUNDLE_ID,
          assets: {
            "index.ios.bundle": {
              downloadFileHash: DOWNLOAD_HASH,
              fileHash: BUNDLE_HASH,
            },
          },
        }),
      ),
    }));
    mockStorageNode.listObjects.mockResolvedValue([
      object(
        `assets/sha256/${DOWNLOAD_HASH.slice(0, 2)}/${DOWNLOAD_HASH}.br`,
        old,
      ),
      object(`assets/sha256/${BUNDLE_HASH.slice(0, 2)}/${BUNDLE_HASH}.br`, old),
    ]);
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.deleteObjects).toHaveBeenCalledWith([
      `assets/sha256/${BUNDLE_HASH.slice(0, 2)}/${BUNDLE_HASH}.br`,
    ]);
  });

  it("falls back to the logical hash for a malformed downloadFileHash", async () => {
    mockStorageNode.get.mockImplementation(async () => ({
      response: new Response(
        JSON.stringify({
          bundleId: LIVE_BUNDLE_ID,
          assets: {
            "index.ios.bundle": {
              downloadFileHash: "not-a-sha256",
              fileHash: BUNDLE_HASH,
            },
          },
        }),
      ),
    }));
    mockStorageNode.listObjects.mockResolvedValue([
      object(`assets/sha256/${BUNDLE_HASH.slice(0, 2)}/${BUNDLE_HASH}.br`, old),
      object(
        `assets/sha256/${DOWNLOAD_HASH.slice(0, 2)}/${DOWNLOAD_HASH}.br`,
        old,
      ),
    ]);
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.deleteObjects).toHaveBeenCalledWith([
      `assets/sha256/${DOWNLOAD_HASH.slice(0, 2)}/${DOWNLOAD_HASH}.br`,
    ]);
  });

  it("deletes an old unreferenced patch below a live Bundle", async () => {
    mockStorageNode.listObjects.mockResolvedValue([
      object(ORPHAN_PATCH_KEY, old),
    ]);
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.deleteObjects).toHaveBeenCalledWith([
      ORPHAN_PATCH_KEY,
    ]);
  });

  it("preserves a patch referenced by its live Bundle", async () => {
    mockDatabase.bundlePages.mockResolvedValue(bundlePage(liveBundleWithPatch));
    mockStorageNode.listObjects.mockResolvedValue([
      object(ORPHAN_PATCH_KEY, old),
    ]);
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("preserves a patch that becomes referenced during the final scan", async () => {
    mockDatabase.bundlePages
      .mockResolvedValueOnce(bundlePage(liveBundle))
      .mockResolvedValueOnce(bundlePage(liveBundleWithPatch));
    mockStorageNode.listObjects.mockResolvedValue([
      object(ORPHAN_PATCH_KEY, old),
    ]);
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockDatabase.bundlePages).toHaveBeenCalledTimes(2);
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("does not treat an unrecognized live Bundle path as a patch", async () => {
    const unknownPatchPath = `bundles/${LIVE_BUNDLE_ID}/patches/not-a-bundle/readme.txt`;
    mockStorageNode.listObjects.mockResolvedValue([
      object(unknownPatchPath, old),
    ]);
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
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
    expect(output).toContain(`bundles/${DEAD_BUNDLE_ID}/bundle.tar.br`);
    expect(output).toContain(`bundles/${DEAD_BUNDLE_ID}/manifest.json`);
    expect(output).toContain("shared asset");
    expect(output).toContain("bundle data");
    expect(output).toContain("30 B");
    expect(output).toContain(old.toISOString());
    expect(output).not.toContain(YOUNG_ORPHAN_HASH);
    expect(output).not.toContain(`bundles/${LIVE_BUNDLE_ID}/bundle.tar.br`);
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
    mockStorageNode.get.mockImplementation(async () => {
      manifestReadCount += 1;
      return {
        response: new Response(
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
        ),
      };
    });
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.deleteObjects).toHaveBeenCalledWith([
      `bundles/${DEAD_BUNDLE_ID}/bundle.tar.br`,
      `bundles/${DEAD_BUNDLE_ID}/manifest.json`,
    ]);
  });

  it("does not delete when the final reference scan fails", async () => {
    let manifestReadCount = 0;
    mockStorageNode.get.mockImplementation(async () => {
      manifestReadCount += 1;
      if (manifestReadCount > 1) {
        throw new Error("manifest unavailable");
      }
      return {
        response: new Response(
          JSON.stringify({
            bundleId: LIVE_BUNDLE_ID,
            assets: {
              "images/logo.png": { fileHash: IMAGE_HASH },
              "index.ios.bundle": { fileHash: BUNDLE_HASH },
            },
          }),
        ),
      };
    });
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune({ yes: true })).rejects.toThrow(
      `failed to read manifest for bundle ${LIVE_BUNDLE_ID}`,
    );
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("does not traverse UUID-shaped root namespaces", async () => {
    const uuidChannelMetadata = `${DEAD_BUNDLE_ID}/ios/1.0.0/update.json`;
    mockStorageNode.listObjects.mockResolvedValue([
      object(uuidChannelMetadata, old),
      object(`${DEAD_BUNDLE_ID}/bundle.tar.br`, old),
    ]);
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ yes: true });

    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      "No objects are eligible for pruning.",
    );
  });

  it("fails closed when the asset base uses another storage protocol", async () => {
    mockDatabase.bundlePages.mockResolvedValue([
      {
        ...liveBundle,
        assetBaseStorageUri: "https://cdn.example.com/assets",
      },
    ]);
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune({ yes: true })).rejects.toThrow(
      "uses https asset storage",
    );
    expect(mockStorageNode.listObjects).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("allows an HTTP manifest when shared assets use the configured storage", async () => {
    mockDatabase.bundlePages.mockResolvedValue([
      {
        ...liveBundle,
        manifestStorageUri: "https://cdn.example.com/manifest.json",
      },
    ]);
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
    mockStorageNode.get.mockImplementation(async () => ({
      response: new Response(
        JSON.stringify({
          bundleId: DEAD_BUNDLE_ID,
          assets: {
            "images/logo.png": { fileHash: IMAGE_HASH },
          },
        }),
      ),
    }));
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune({ yes: true })).rejects.toThrow(
      `invalid manifest for bundle ${LIVE_BUNDLE_ID}`,
    );
    expect(mockStorageNode.listObjects).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("fails closed when a manifest contains a malformed asset hash", async () => {
    mockStorageNode.get.mockImplementation(async () => ({
      response: new Response(
        JSON.stringify({
          bundleId: LIVE_BUNDLE_ID,
          assets: {
            "images/logo.png": { fileHash: "not-a-sha256" },
          },
        }),
      ),
    }));
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune({ yes: true })).rejects.toThrow(
      `invalid manifest for bundle ${LIVE_BUNDLE_ID}`,
    );
    expect(mockStorageNode.listObjects).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
  });

  it("reads every bundle in pages by key", async () => {
    const page = Array.from({ length: 100 }, (_, index) => {
      const id = `0195a408-8f13-7d9b-8df4-${String(index).padStart(12, "0")}`;
      return {
        ...liveBundle,
        id,
        manifestStorageUri: `s3://bucket/bundles/${id}/manifest.json`,
      };
    });
    mockDatabase.bundlePages
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([]);
    mockStorageNode.get.mockImplementation(
      async ({ storageUri }: { readonly storageUri: string }) => ({
        response: new Response(
          JSON.stringify({
            bundleId: storageUri.split("/").at(-2),
            assets: {},
          }),
        ),
      }),
    );
    const { handleStoragePrune } = await import("./storage");

    await handleStoragePrune({ dryRun: true });

    expect(mockDatabase.core.listBundles).toHaveBeenNthCalledWith(1, {
      limit: 100,
      order: "desc",
    });
    expect(mockDatabase.core.listBundles).toHaveBeenNthCalledWith(2, {
      limit: 100,
      order: "desc",
      after: page.at(-1)!.id,
    });
  });

  it("aborts before listing or deletion when a live manifest cannot be read", async () => {
    mockStorageNode.get.mockRejectedValueOnce(new Error("manifest missing"));
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune({ yes: true })).rejects.toThrow(
      `failed to read manifest for bundle ${LIVE_BUNDLE_ID}`,
    );

    expect(mockStorageNode.listObjects).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
    expect(mockDatabase.dispose).toHaveBeenCalledOnce();
  });

  it("reports when the configured storage plugin cannot enumerate objects", async () => {
    mockCli.loadConfig.mockResolvedValue({
      database: mockDatabase,
      storage: {
        ...mockStoragePlugin,
        name: "unsupportedStorage",
        listObjects: undefined,
      },
    });
    const { handleStoragePrune } = await import("./storage");

    await expect(handleStoragePrune()).rejects.toThrow(
      'Storage plugin "unsupportedStorage" does not support storage prune.',
    );

    expect(mockStorageNode.get).not.toHaveBeenCalled();
    expect(mockStorageNode.deleteObjects).not.toHaveBeenCalled();
    expect(mockDatabase.dispose).toHaveBeenCalledOnce();
  });
});
