import {
  getBundlePatches,
  getManifestStorageUri,
  getPatchStorageUri,
} from "@hot-updater/core";
import {
  type Bundle,
  type HotUpdaterCoreApi,
  rowToBundle,
  type StorageAdapter,
  type StorageAdapterWith,
} from "@hot-updater/plugin-core";

interface DeleteBundleInput {
  bundleId: string;
}

interface DeleteBundlesInput {
  bundleIds: readonly string[];
}

interface DeleteBundleDependencies {
  core: Pick<HotUpdaterCoreApi, "getBundle" | "deleteBundles">;
  /** The server's storage; each file is deleted with its protocol's. */
  storage: readonly StorageAdapter[];
  waitForStorageCleanup?: boolean;
}

/** The storage that deletes `storageUri`, or null for an HTTP(S) URL. */
function resolveStorageForDeletion(
  storageUri: string,
  storage: readonly StorageAdapter[],
): StorageAdapterWith<"delete"> | null {
  const protocol = new URL(storageUri).protocol.replace(":", "");
  const storageAdapter = storage.find(
    (adapter) => adapter.protocol === protocol,
  );

  if (storageAdapter?.delete !== undefined) {
    return storageAdapter as StorageAdapterWith<"delete">;
  }

  if (protocol === "http" || protocol === "https") {
    return null;
  }

  throw new Error(
    storageAdapter === undefined
      ? `No storage adapter for protocol: ${protocol}`
      : `Storage adapter "${storageAdapter.name}" does not implement delete.`,
  );
}

async function cleanupBundleStorage(
  bundle: Bundle,
  storage: readonly StorageAdapter[],
) {
  const cleanup = new Map<string, StorageAdapterWith<"delete">>();
  const addCleanupUri = (storageUri: string | undefined) => {
    if (!storageUri) return;
    const storageAdapter = resolveStorageForDeletion(storageUri, storage);
    if (storageAdapter) cleanup.set(storageUri, storageAdapter);
  };

  addCleanupUri(getManifestStorageUri(bundle));
  addCleanupUri(getPatchStorageUri(bundle) ?? undefined);
  for (const patch of getBundlePatches(bundle)) {
    addCleanupUri(patch.patchStorageUri);
  }

  for (const [storageUri, storageAdapter] of cleanup) {
    try {
      await storageAdapter.delete({ storageUri });
    } catch (error) {
      console.error("Failed to delete bundle from storage:", error);
    }
  }
}

export async function deleteBundles(
  { bundleIds }: DeleteBundlesInput,
  { core, storage, waitForStorageCleanup = true }: DeleteBundleDependencies,
) {
  const uniqueBundleIds = [...new Set(bundleIds)];
  const details = await Promise.all(
    uniqueBundleIds.map((bundleId) => core.getBundle(bundleId)),
  );
  const bundles = details.flatMap((detail) =>
    detail === null ? [] : [rowToBundle(detail.bundle, detail.patches)],
  );
  const missingBundleIds = uniqueBundleIds.filter(
    (_bundleId, position) => details[position] === null,
  );

  for (const bundle of bundles) {
    const cleanupCandidates = [
      getManifestStorageUri(bundle),
      getPatchStorageUri(bundle),
      ...getBundlePatches(bundle).map((patch) => patch.patchStorageUri),
    ].filter((value): value is string => Boolean(value));
    // Refuses before anything is deleted when a file has no storage.
    for (const candidate of cleanupCandidates) {
      resolveStorageForDeletion(candidate, storage);
    }
  }

  // One core write; a bundle a release still uses refuses the whole batch.
  if (bundles.length > 0) {
    await core.deleteBundles(bundles.map((bundle) => bundle.id));
  }

  const cleanupStorage = async () => {
    for (const bundle of bundles) {
      await cleanupBundleStorage(bundle, storage);
    }
  };

  if (waitForStorageCleanup) {
    await cleanupStorage();
  } else {
    void cleanupStorage().catch((error) => {
      console.error("Failed to clean up bundle storage:", error);
    });
  }

  return {
    deletedBundleIds: bundles.map((bundle) => bundle.id),
    missingBundleIds,
  };
}

export async function deleteBundle(
  { bundleId }: DeleteBundleInput,
  dependencies: DeleteBundleDependencies,
) {
  const result = await deleteBundles({ bundleIds: [bundleId] }, dependencies);
  if (result.missingBundleIds.length > 0) {
    throw new Error(`Bundle not found: ${bundleId}`);
  }
}
