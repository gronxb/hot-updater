import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestStorageUri,
  getPatchStorageUri,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabaseClient,
  NodeStoragePlugin,
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
  storagePlugin: NodeStoragePlugin;
  waitForStorageCleanup?: boolean;
}

interface BundleManifest {
  assets?: Record<string, { fileHash: string; signature?: string }>;
}

const HOT_UPDATER_DOWNLOAD_DIR_PREFIX = "downloads-";

function resolveStorageUriForDeletion(
  storageUri: string,
  storagePlugin: NodeStoragePlugin,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (protocol === "http" || protocol === "https") {
    return null;
  }

  if (storagePlugin.supportedProtocol !== protocol) {
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  }

  return storageUri;
}

async function downloadStorageBytes(
  storageUri: string,
  storagePlugin: NodeStoragePlugin,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (protocol === "http" || protocol === "https") {
    const response = await fetch(storageUri);
    if (!response.ok) {
      throw new Error(
        `Failed to download bundle manifest: ${response.statusText}`,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  if (storagePlugin.supportedProtocol !== protocol) {
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  }

  const downloadRoot = path.join(process.cwd(), ".hot-updater");
  await fs.mkdir(downloadRoot, { recursive: true });
  const workDir = await fs.mkdtemp(
    path.join(downloadRoot, HOT_UPDATER_DOWNLOAD_DIR_PREFIX),
  );
  const filename = path.basename(new URL(storageUri).pathname) || randomUUID();
  const filePath = path.join(workDir, filename);

  try {
    await storagePlugin.profiles.node.downloadFile(storageUri, filePath);
    return new Uint8Array(await fs.readFile(filePath));
  } finally {
    await fs.rm(workDir, { force: true, recursive: true });
  }
}

async function loadBundleManifest(
  manifestStorageUri: string,
  storagePlugin: NodeStoragePlugin,
) {
  const manifestBytes = await downloadStorageBytes(
    manifestStorageUri,
    storagePlugin,
  );

  return JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest;
}

async function cleanupBundleStorage(
  bundle: Bundle,
  storagePlugin: NodeStoragePlugin,
) {
  const cleanupUris = new Set<string>();
  const addCleanupUri = (storageUri: string | undefined) => {
    if (!storageUri) {
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

  for (const storageUri of cleanupUris) {
    try {
      await storagePlugin.profiles.node.delete(storageUri);
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
    return {
      deletedBundleIds: bundles.map((bundle) => bundle.id),
      missingBundleIds,
    };
  }

  void cleanupStorage().catch((error) => {
    console.error("Failed to clean up bundle storage:", error);
  });
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
