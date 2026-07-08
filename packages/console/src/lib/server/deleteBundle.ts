import {
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestStorageUri,
  getPatchStorageUri,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabasePlugin,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import {
  assertStorageDelete,
  assertStorageReadText,
  isContentAddressedAssetBaseStorageUri,
} from "@hot-updater/plugin-core";

import { getLegacyBundleAssetCleanupUris } from "./legacyBundleAssetCleanup";

interface DeleteBundleInput {
  bundleId: string;
}

interface DeleteBundleDependencies {
  databasePlugin: DatabasePlugin;
  storagePlugin: StoragePlugin;
  waitForStorageCleanup?: boolean;
}

interface BundleManifest {
  assets?: Record<string, { fileHash: string; signature?: string }>;
}

function resolveStorageUriForDeletion(
  storageUri: string,
  storagePlugin: StoragePlugin,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (protocol === "http" || protocol === "https") {
    return null;
  }

  if (storagePlugin.supportedProtocol !== protocol) {
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  }

  assertStorageDelete(storagePlugin);
  return storageUri;
}

async function readStorageText(
  storageUri: string,
  storagePlugin: StoragePlugin,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (protocol === "http" || protocol === "https") {
    const response = await fetch(storageUri);
    if (!response.ok) {
      throw new Error(
        `Failed to download bundle manifest: ${response.statusText}`,
      );
    }

    return response.text();
  }

  if (storagePlugin.supportedProtocol !== protocol) {
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  }

  assertStorageReadText(storagePlugin);
  const text = await storagePlugin.readText(storageUri);
  if (text === null) {
    throw new Error(`Failed to read bundle manifest: ${storageUri}`);
  }
  return text;
}

async function loadBundleManifest(
  manifestStorageUri: string,
  storagePlugin: StoragePlugin,
) {
  const manifestText = await readStorageText(manifestStorageUri, storagePlugin);

  return JSON.parse(manifestText) as BundleManifest;
}

function collectStorageReferenceUris(bundle: Bundle) {
  return [
    bundle.storageUri,
    getManifestStorageUri(bundle),
    getAssetBaseStorageUri(bundle),
    getPatchStorageUri(bundle),
    ...getBundlePatches(bundle).map((patch) => patch.patchStorageUri),
  ].filter((value): value is string => Boolean(value));
}

async function collectRemainingStorageReferenceUris(
  databasePlugin: DatabasePlugin,
  deletedBundleId: string,
) {
  const referencedStorageUris = new Set<string>();
  let cursorAfter: string | undefined;
  let page = 1;

  for (;;) {
    const result = await databasePlugin.getBundles({
      limit: 100,
      ...(cursorAfter ? { cursor: { after: cursorAfter } } : { page }),
      orderBy: { field: "id", direction: "asc" },
    });

    for (const bundle of result.data) {
      if (bundle.id === deletedBundleId) {
        continue;
      }

      for (const storageUri of collectStorageReferenceUris(bundle)) {
        referencedStorageUris.add(storageUri);
      }
    }

    if (!result.pagination.hasNextPage) {
      break;
    }

    if (result.pagination.nextCursor) {
      cursorAfter = result.pagination.nextCursor;
    } else {
      page += 1;
    }
  }

  return referencedStorageUris;
}

export async function deleteBundle(
  { bundleId }: DeleteBundleInput,
  {
    databasePlugin,
    storagePlugin,
    waitForStorageCleanup = true,
  }: DeleteBundleDependencies,
) {
  const bundle = await databasePlugin.getBundleById(bundleId);
  if (!bundle) {
    throw new Error("Bundle not found");
  }

  const cleanupCandidates = collectStorageReferenceUris(bundle);

  for (const candidate of cleanupCandidates) {
    resolveStorageUriForDeletion(candidate, storagePlugin);
  }

  await databasePlugin.deleteBundle(bundle);
  await databasePlugin.commitBundle();

  const cleanupStorage = async () => {
    const referencedStorageUris = await collectRemainingStorageReferenceUris(
      databasePlugin,
      bundle.id,
    );
    const cleanupUris = new Set<string>();
    const addCleanupUri = (storageUri: string | undefined) => {
      if (!storageUri) {
        return;
      }

      if (referencedStorageUris.has(storageUri)) {
        return;
      }

      const resolvedStorageUri = resolveStorageUriForDeletion(
        storageUri,
        storagePlugin,
      );
      if (resolvedStorageUri) {
        cleanupUris.add(resolvedStorageUri);
      }
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
        if (!isContentAddressedAssetBaseStorageUri(assetBaseStorageUri)) {
          addCleanupUri(assetBaseStorageUri);
        }
      } else if (isContentAddressedAssetBaseStorageUri(assetBaseStorageUri)) {
        // New deploys store manifest assets under a shared content-addressed
        // /assets root. Deleting individual shared objects here would require
        // either reference metadata or a storage/DB scan, so bundle deletion
        // leaves them in place and only removes per-bundle archive/manifest data.
      } else {
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
          if (!isContentAddressedAssetBaseStorageUri(assetBaseStorageUri)) {
            addCleanupUri(assetBaseStorageUri);
          }
        }
      }
    }

    if (cleanupUris.size === 0) {
      return;
    }

    assertStorageDelete(storagePlugin);
    for (const storageUri of cleanupUris) {
      try {
        await storagePlugin.delete(storageUri);
      } catch (error) {
        console.error("Failed to delete bundle from storage:", error);
      }
    }
  };

  if (waitForStorageCleanup) {
    await cleanupStorage();
    return;
  }

  void cleanupStorage().catch((error) => {
    console.error("Failed to clean up bundle storage:", error);
  });
}
