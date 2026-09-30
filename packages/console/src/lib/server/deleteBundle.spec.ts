// @vitest-environment node

import {
  type Bundle,
  type BundleDetail,
  bundleToPatchRows,
  bundleToRow,
  createStorageAdapter as createCoreStorageAdapter,
  type StorageAdapter,
  type StorageAdapterWith,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteBundle, deleteBundles } from "./deleteBundle";

const baseBundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  platform: "ios",
  gitCommitHash: "deadbeef",
  manifestStorageUri: "s3://bucket/bundle/manifest.json",
  manifestFileHash: "manifest-hash",
  assetBaseStorageUri: "s3://bucket/assets",
};

const detailOf = (bundle: Bundle): BundleDetail => ({
  bundle: bundleToRow(bundle),
  patches: bundleToPatchRows(bundle),
  childCount: 0,
});

/** Core over these bundles: point reads, and one delete call. */
function createCore(...bundles: Bundle[]) {
  const details = new Map(
    bundles.map((bundle) => [bundle.id, detailOf(bundle)]),
  );
  return {
    getBundle: vi.fn(async (id: string) => details.get(id) ?? null),
    deleteBundles: vi.fn(async (_ids: readonly string[]): Promise<void> => {}),
  };
}

function createStorageAdapter(
  protocol = "s3",
  overrides?: Partial<StorageAdapter>,
): StorageAdapterWith<"get" | "delete"> {
  const get =
    overrides?.get ??
    vi.fn(async ({ storageUri }: { storageUri: string }) => {
      const storageUrl = new URL(storageUri);
      const response = await fetch(
        `https://assets.example.com${storageUrl.pathname}`,
      );
      return { response: response.ok ? response : null };
    });
  return createCoreStorageAdapter({
    name: "mockStorage",
    protocol,
    get,
    delete:
      overrides?.delete ?? vi.fn(async () => ({ deleted: true as const })),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteBundle", () => {
  it("deletes the bundle from database and storage", async () => {
    const core = createCore(baseBundle);
    const deleteFromStorage = vi.fn();
    const storageAdapter = createStorageAdapter("s3", {
      delete: deleteFromStorage,
    });

    await deleteBundle({ bundleId: baseBundle.id }, { core, storageAdapter });

    expect(core.getBundle).toHaveBeenCalledWith(baseBundle.id);
    expect(core.deleteBundles).toHaveBeenCalledOnce();
    expect(core.deleteBundles).toHaveBeenCalledWith([baseBundle.id]);
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: baseBundle.manifestStorageUri,
    });

    expect(core.deleteBundles.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFromStorage.mock.invocationCallOrder[0]!,
    );
  });

  it("deletes multiple bundles with one database commit", async () => {
    const secondBundle = {
      ...baseBundle,
      id: "0195a408-8f13-7d9b-8df4-123456789abd",
      manifestStorageUri: "s3://bucket/second-bundle/manifest.json",
    };
    const core = createCore(baseBundle, secondBundle);
    const deleteFromStorage = vi.fn();
    const storageAdapter = createStorageAdapter("s3", {
      delete: deleteFromStorage,
    });

    await deleteBundles(
      { bundleIds: [baseBundle.id, secondBundle.id] },
      { core, storageAdapter },
    );

    expect(core.getBundle).toHaveBeenCalledTimes(2);
    expect(core.deleteBundles).toHaveBeenCalledOnce();
    expect(core.deleteBundles).toHaveBeenCalledWith([
      baseBundle.id,
      secondBundle.id,
    ]);
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: baseBundle.manifestStorageUri,
    });
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: secondBundle.manifestStorageUri,
    });
  });

  it("deletes found bundles and reports stale ids in the same batch", async () => {
    const core = createCore(baseBundle);
    const storageAdapter = createStorageAdapter();

    await expect(
      deleteBundles(
        { bundleIds: [baseBundle.id, "missing-bundle"] },
        { core, storageAdapter },
      ),
    ).resolves.toEqual({
      deletedBundleIds: [baseBundle.id],
      missingBundleIds: ["missing-bundle"],
    });

    expect(core.deleteBundles).toHaveBeenCalledOnce();
    expect(core.deleteBundles).toHaveBeenCalledWith([baseBundle.id]);
    expect(storageAdapter.delete).toHaveBeenCalledWith({
      storageUri: baseBundle.manifestStorageUri,
    });
  });

  it("deduplicates ids before database and storage deletion", async () => {
    const core = createCore(baseBundle);
    const storageAdapter = createStorageAdapter();

    await deleteBundles(
      { bundleIds: [baseBundle.id, baseBundle.id] },
      { core, storageAdapter },
    );

    expect(core.getBundle).toHaveBeenCalledOnce();
    expect(core.deleteBundles).toHaveBeenCalledOnce();
    expect(core.deleteBundles).toHaveBeenCalledWith([baseBundle.id]);
    expect(storageAdapter.delete).toHaveBeenCalledOnce();
  });

  it("skips storage deletion for http urls", async () => {
    const core = createCore({
      ...baseBundle,
      manifestStorageUri: "https://cdn.example.com/manifest.json",
    });
    const deleteFromStorage = vi.fn();
    const storageAdapter = createStorageAdapter("s3", {
      delete: deleteFromStorage,
    });

    await deleteBundle({ bundleId: baseBundle.id }, { core, storageAdapter });

    expect(core.deleteBundles).toHaveBeenCalledOnce();
    expect(deleteFromStorage).not.toHaveBeenCalled();
  });

  it("uses an owning https plugin before the direct URL fallback", async () => {
    const storageUri = "https://cdn.example.com/bundle.zip";
    const core = createCore({
      ...baseBundle,
      manifestStorageUri: storageUri,
    });
    const deleteFromStorage = vi.fn(async () => ({ deleted: true as const }));
    const storageAdapter = createStorageAdapter("https", {
      delete: deleteFromStorage,
    });

    await deleteBundle({ bundleId: baseBundle.id }, { core, storageAdapter });

    expect(deleteFromStorage).toHaveBeenCalledWith({ storageUri });
  });

  it("throws before database deletion when the storage protocol is unsupported", async () => {
    const core = createCore({
      ...baseBundle,
      manifestStorageUri: "r2://bucket/bundle/manifest.json",
    });
    const storageAdapter = createStorageAdapter("s3");

    await expect(
      deleteBundle({ bundleId: baseBundle.id }, { core, storageAdapter }),
    ).rejects.toThrow("No storage adapter for protocol: r2");

    expect(core.deleteBundles).not.toHaveBeenCalled();
    expect(storageAdapter.delete).not.toHaveBeenCalled();
  });

  it("keeps bundle deletion successful when storage cleanup fails", async () => {
    const core = createCore(baseBundle);
    const deleteFromStorage = vi.fn(async () => {
      throw new Error("storage delete failed");
    });
    const storageAdapter = createStorageAdapter("s3", {
      delete: deleteFromStorage,
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      deleteBundle({ bundleId: baseBundle.id }, { core, storageAdapter }),
    ).resolves.toBeUndefined();

    expect(core.deleteBundles).toHaveBeenCalledOnce();
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: baseBundle.manifestStorageUri,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to delete bundle from storage:",
      expect.any(Error),
    );
  });

  it("can return without waiting for storage cleanup", async () => {
    const core = createCore(baseBundle);
    const deleteFromStorage = vi.fn(
      () => new Promise<{ deleted: true }>(() => undefined),
    );
    const storageAdapter = createStorageAdapter("s3", {
      delete: deleteFromStorage,
    });

    await expect(
      deleteBundle(
        { bundleId: baseBundle.id },
        { core, storageAdapter, waitForStorageCleanup: false },
      ),
    ).resolves.toBeUndefined();

    expect(core.deleteBundles).toHaveBeenCalledOnce();
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: baseBundle.manifestStorageUri,
    });
  });

  it("leaves shared content-addressed assets for storage prune", async () => {
    const bundleWithManifest: Bundle = {
      ...baseBundle,
      assetBaseStorageUri: "s3://bucket/assets",
      manifestFileHash: "manifest-hash",
      manifestStorageUri: "s3://bucket/bundles/bundle-copy-id/manifest.json",
    };
    const core = createCore(bundleWithManifest);
    const deleteFromStorage = vi.fn();
    const storageAdapter = createStorageAdapter("s3", {
      delete: deleteFromStorage,
    });

    const fetchManifest = vi.fn();
    vi.stubGlobal("fetch", fetchManifest);

    await deleteBundle(
      { bundleId: bundleWithManifest.id },
      { core, storageAdapter },
    );

    expect(core.getBundle).toHaveBeenCalledOnce();
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(deleteFromStorage).toHaveBeenCalledTimes(1);
    expect(deleteFromStorage).toHaveBeenCalledWith({
      storageUri: bundleWithManifest.manifestStorageUri,
    });
    expect(deleteFromStorage).not.toHaveBeenCalledWith({
      storageUri: bundleWithManifest.assetBaseStorageUri,
    });
    expect(deleteFromStorage).not.toHaveBeenCalledWith({
      storageUri: "s3://bucket/assets/sha256/lo/logo-hash.png",
    });
    expect(deleteFromStorage).not.toHaveBeenCalledWith({
      storageUri: "s3://bucket/assets/sha256/bu/bundle-hash.br",
    });
  });

  it("throws before database deletion when manifest storage uses an unsupported storage protocol", async () => {
    const core = createCore({
      ...baseBundle,
      manifestStorageUri: "r2://bucket/bundle/manifest.json",
    });
    const storageAdapter = createStorageAdapter("s3");

    await expect(
      deleteBundle({ bundleId: baseBundle.id }, { core, storageAdapter }),
    ).rejects.toThrow("No storage adapter for protocol: r2");

    expect(core.deleteBundles).not.toHaveBeenCalled();
  });

  it("leaves storage alone when a release still uses the bundle", async () => {
    const core = createCore(baseBundle);
    core.deleteBundles.mockRejectedValueOnce(
      new Error("bundles: referenced by releases"),
    );
    const storageAdapter = createStorageAdapter("s3");

    await expect(
      deleteBundle({ bundleId: baseBundle.id }, { core, storageAdapter }),
    ).rejects.toThrow("referenced by releases");

    expect(storageAdapter.delete).not.toHaveBeenCalled();
  });
});
