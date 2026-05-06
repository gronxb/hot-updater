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
  DatabasePlugin,
  NodeStoragePlugin,
} from "@hot-updater/plugin-core";

interface DeleteBundleInput {
  bundleId: string;
}

interface DeleteBundleDependencies {
  databasePlugin: DatabasePlugin;
  storagePlugin: NodeStoragePlugin;
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

function createStorageUriWithRelativePath(
  baseStorageUri: string,
  relativePath: string,
) {
  const storageUrl = new URL(baseStorageUri);
  const normalizedBasePath = storageUrl.pathname.replace(/\/+$/, "");
  const normalizedRelativePath = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  storageUrl.pathname = `${normalizedBasePath}/${normalizedRelativePath}`;
  return storageUrl.toString();
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

export async function deleteBundle(
  { bundleId }: DeleteBundleInput,
  { databasePlugin, storagePlugin }: DeleteBundleDependencies,
) {
  const bundle = await databasePlugin.getBundleById(bundleId);
  if (!bundle) {
    throw new Error("Bundle not found");
  }

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

  await databasePlugin.deleteBundle(bundle);
  await databasePlugin.commitBundle();

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
      addCleanupUri(assetBaseStorageUri);
    } else {
      try {
        const manifest = await loadBundleManifest(
          manifestStorageUri,
          storagePlugin,
        );
        const assetPaths = Object.keys(manifest.assets ?? {}).sort((a, b) =>
          a.localeCompare(b),
        );

        for (const assetPath of assetPaths) {
          addCleanupUri(
            createStorageUriWithRelativePath(assetBaseStorageUri, assetPath),
          );
        }
      } catch (error) {
        console.error(
          "Failed to load bundle manifest for storage cleanup:",
          error,
        );
        addCleanupUri(assetBaseStorageUri);
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
