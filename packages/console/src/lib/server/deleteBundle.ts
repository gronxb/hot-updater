import {
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestStorageUri,
  getPatchStorageUri,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabaseClient,
  StoragePluginWith,
} from "@hot-updater/plugin-core";
import { isContentAddressedAssetBaseStorageUri } from "@hot-updater/plugin-core";

import { getLegacyBundleAssetCleanupUris } from "./legacyBundleAssetCleanup";

interface DeleteBundleInput {
  bundleId: string;
}

interface DeleteBundlesInput {
  bundleIds: readonly string[];
}

interface DeleteBundleDependencies {
  databaseClient: DatabaseClient;
  storagePlugin: StoragePluginWith<"get" | "delete">;
  waitForStorageCleanup?: boolean;
}

interface BundleManifest {
  assets?: Record<string, { fileHash: string; signature?: string }>;
}

function resolveStorageUriForDeletion(
  storageUri: string,
  storagePlugin: StoragePluginWith<"get" | "delete">,
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

async function downloadStorageBytes(
  storageUri: string,
  storagePlugin: StoragePluginWith<"get" | "delete">,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (storagePlugin.protocol === protocol) {
    const { response } = await storagePlugin.get({ storageUri });
    if (response === null) {
      throw new Error(`Storage object not found: ${storageUri}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  if (protocol === "http" || protocol === "https") {
    const response = await fetch(storageUri);
    if (!response.ok) {
      throw new Error(
        `Failed to download bundle manifest: ${response.statusText}`,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  throw new Error(`No storage plugin for protocol: ${protocol}`);
}

async function loadBundleManifest(
  manifestStorageUri: string,
  storagePlugin: StoragePluginWith<"get" | "delete">,
) {
  const manifestBytes = await downloadStorageBytes(
    manifestStorageUri,
    storagePlugin,
  );

  return JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest;
}

async function cleanupBundleStorage(
  bundle: Bundle,
  storagePlugin: StoragePluginWith<"get" | "delete">,
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

  const manifestStorageUri = getManifestStorageUri(bundle);
  const assetBaseStorageUri = getAssetBaseStorageUri(bundle);
  if (assetBaseStorageUri) {
    if (!manifestStorageUri) {
      // The flat storage v2 delete contract removes one exact object. A legacy
      // asset base URI is a prefix, so it must not be passed as an object key.
    } else if (!isContentAddressedAssetBaseStorageUri(assetBaseStorageUri)) {
      try {
        const manifest = await loadBundleManifest(
          manifestStorageUri,
          storagePlugin,
        );
        for (const storageUri of getLegacyBundleAssetCleanupUris({
          assetBaseStorageUri,
          manifest,
        })) {
          addCleanupUri(storageUri);
        }
      } catch (error) {
        console.error(
          "Failed to load bundle manifest for storage cleanup:",
          error,
        );
      }
    }
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
      getAssetBaseStorageUri(bundle),
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
