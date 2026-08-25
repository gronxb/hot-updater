import {
  getBundlePatches,
  getManifestStorageUri,
  getPatchStorageUri,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabaseClient,
  StoragePluginWith,
} from "@hot-updater/plugin-core";

interface DeleteBundleInput {
  bundleId: string;
}

interface DeleteBundlesInput {
  bundleIds: readonly string[];
}

interface DeleteBundleDependencies {
  databaseClient: DatabaseClient;
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

  addCleanupUri(bundle.storageUri);
  addCleanupUri(getManifestStorageUri(bundle) ?? undefined);
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
    databaseClient,
    storagePlugin,
    waitForStorageCleanup = true,
  }: DeleteBundleDependencies,
) {
  const uniqueBundleIds = [...new Set(bundleIds)];
  const { data: matchedBundles } = await databaseClient.getBundles({
    where: { id: { in: uniqueBundleIds } },
    limit: uniqueBundleIds.length,
  });
  const matchedById = new Map(
    matchedBundles.map((bundle) => [bundle.id, bundle]),
  );
  const bundles = uniqueBundleIds.flatMap((bundleId) => {
    const bundle = matchedById.get(bundleId);
    return bundle ? [bundle] : [];
  });
  const missingBundleIds = uniqueBundleIds.filter(
    (bundleId) => !matchedById.has(bundleId),
  );

  for (const bundle of bundles) {
    const cleanupCandidates = [
      bundle.storageUri,
      getManifestStorageUri(bundle),
      getPatchStorageUri(bundle),
      ...getBundlePatches(bundle).map((patch) => patch.patchStorageUri),
    ].filter((value): value is string => Boolean(value));
    for (const candidate of cleanupCandidates) {
      resolveStorageUriForDeletion(candidate, storagePlugin);
    }
  }

  if (bundles.length > 0) {
    await databaseClient.mutate(async (mutation) => {
      for (const bundle of bundles) {
        await mutation.deleteBundleById(bundle.id);
      }
    });
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
