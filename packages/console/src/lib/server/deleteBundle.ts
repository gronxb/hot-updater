import {
  getBundlePatches,
  getManifestStorageUri,
  getPatchStorageUri,
} from "@hot-updater/core";
import {
  type Bundle,
  type HotUpdaterCoreApi,
  rowToBundle,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";

interface DeleteBundleInput {
  bundleId: string;
}

interface DeleteBundlesInput {
  bundleIds: readonly string[];
}

interface DeleteBundleDependencies {
  core: Pick<HotUpdaterCoreApi, "getBundle" | "deleteBundles">;
  storagePlugin: StoragePluginWith<"delete">;
  waitForStorageCleanup?: boolean;
}

function resolveStorageUriForDeletion(
  storageUri: string,
  storagePlugin: StoragePluginWith<"delete">,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (storagePlugin.protocol === protocol) {
    return storageUri;
  }

  if (protocol === "http" || protocol === "https") {
    return null;
  }

  throw new Error(`No storage plugin for protocol: ${protocol}`);
}

async function cleanupBundleStorage(
  bundle: Bundle,
  storagePlugin: StoragePluginWith<"delete">,
) {
  const cleanupUris = new Set<string>();
  const addCleanupUri = (storageUri: string | undefined) => {
    if (!storageUri) return;
    const resolvedStorageUri = resolveStorageUriForDeletion(
      storageUri,
      storagePlugin,
    );
    if (resolvedStorageUri) cleanupUris.add(resolvedStorageUri);
  };

  addCleanupUri(getManifestStorageUri(bundle));
  addCleanupUri(getPatchStorageUri(bundle) ?? undefined);
  for (const patch of getBundlePatches(bundle)) {
    addCleanupUri(patch.patchStorageUri);
  }

  for (const storageUri of cleanupUris) {
    try {
      await storagePlugin.delete({ storageUri });
    } catch (error) {
      console.error("Failed to delete bundle from storage:", error);
    }
  }
}

export async function deleteBundles(
  { bundleIds }: DeleteBundlesInput,
  {
    core,
    storagePlugin,
    waitForStorageCleanup = true,
  }: DeleteBundleDependencies,
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
    for (const candidate of cleanupCandidates) {
      resolveStorageUriForDeletion(candidate, storagePlugin);
    }
  }

  // One core write; a bundle a release still uses refuses the whole batch.
  if (bundles.length > 0) {
    await core.deleteBundles(bundles.map((bundle) => bundle.id));
  }

  const cleanupStorage = async () => {
    for (const bundle of bundles) {
      await cleanupBundleStorage(bundle, storagePlugin);
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
