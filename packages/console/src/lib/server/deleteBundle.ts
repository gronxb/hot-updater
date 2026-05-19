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
  waitForStorageCleanup?: boolean;
}

interface BundleManifest {
  assets?: Record<string, { fileHash: string; signature?: string }>;
}

interface ContentAddressedAssetReferenceFile {
  version: 1;
  storageUri: string;
  references: Record<
    string,
    {
      assetPath: string;
      bundleId: string;
    }
  >;
}

const HOT_UPDATER_DOWNLOAD_DIR_PREFIX = "downloads-";
const HOT_UPDATER_UPLOAD_DIR_PREFIX = "uploads-";
const BR_COMPRESSED_ASSET_PATH_RE = /(^|\/)index\.[^/]+\.bundle$/;

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

function isContentAddressedAssetBaseStorageUri(storageUri: string) {
  // Content-addressed assets are shared across bundles, so deletion must never
  // remove the shared /assets root. Individual objects are GC'd only after the
  // storage-side reference file says this bundle is the final owner.
  const pathname = new URL(storageUri).pathname.replace(/\/+$/, "");
  return pathname.endsWith("/assets") || pathname === "/assets";
}

function getRelativeStorageDir(storagePath: string) {
  const relativeDir = path.posix.dirname(storagePath);
  return relativeDir === "." ? "" : relativeDir;
}

function getContentAddressedAssetStoragePath({
  assetPath,
  fileHash,
}: {
  assetPath: string;
  fileHash: string;
}) {
  const uploadPath = BR_COMPRESSED_ASSET_PATH_RE.test(assetPath)
    ? `${assetPath}.br`
    : assetPath;
  const extension = path.posix.extname(uploadPath);
  return `sha256/${fileHash.slice(0, 2)}/${fileHash}${extension}`;
}

function getContentAddressedAssetReferenceStoragePath(storagePath: string) {
  return `refs/${storagePath}.json`;
}

function getContentAddressedManifestAssetStorageReferences({
  assetBaseStorageUri,
  manifest,
}: {
  assetBaseStorageUri: string;
  manifest: BundleManifest;
}) {
  const references = new Map<
    string,
    {
      assetStorageUri: string;
      referenceStoragePath: string;
      referenceStorageUri: string;
    }
  >();

  for (const [assetPath, asset] of Object.entries(manifest.assets ?? {})) {
    const storagePath = getContentAddressedAssetStoragePath({
      assetPath,
      fileHash: asset.fileHash,
    });
    const assetStorageUri = createStorageUriWithRelativePath(
      assetBaseStorageUri,
      storagePath,
    );
    const referenceStoragePath =
      getContentAddressedAssetReferenceStoragePath(storagePath);

    references.set(assetStorageUri, {
      assetStorageUri,
      referenceStoragePath,
      referenceStorageUri: createStorageUriWithRelativePath(
        assetBaseStorageUri,
        referenceStoragePath,
      ),
    });
  }

  return [...references.values()];
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

async function loadContentAddressedAssetReference({
  referenceStorageUri,
  storagePlugin,
}: {
  referenceStorageUri: string;
  storagePlugin: NodeStoragePlugin;
}) {
  const referenceBytes = await downloadStorageBytes(
    referenceStorageUri,
    storagePlugin,
  );
  return JSON.parse(
    new TextDecoder().decode(referenceBytes),
  ) as ContentAddressedAssetReferenceFile;
}

async function uploadContentAddressedAssetReference({
  referenceFile,
  referenceStoragePath,
  storagePlugin,
}: {
  referenceFile: ContentAddressedAssetReferenceFile;
  referenceStoragePath: string;
  storagePlugin: NodeStoragePlugin;
}) {
  const uploadRoot = path.join(process.cwd(), ".hot-updater");
  await fs.mkdir(uploadRoot, { recursive: true });
  const workDir = await fs.mkdtemp(
    path.join(uploadRoot, HOT_UPDATER_UPLOAD_DIR_PREFIX),
  );
  const filePath = path.join(workDir, referenceStoragePath);

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(referenceFile, null, 2));

    // Providers prepend their configured base path, so the upload key mirrors
    // deploy's "assets/<relative dir>" convention instead of using a full URI.
    const uploadKey = ["assets", getRelativeStorageDir(referenceStoragePath)]
      .filter(Boolean)
      .join("/");
    await storagePlugin.profiles.node.upload(uploadKey, filePath);
  } finally {
    await fs.rm(workDir, { force: true, recursive: true });
  }
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

  const cleanupStorage = async () => {
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
      } else {
        try {
          const manifest = await loadBundleManifest(
            manifestStorageUri,
            storagePlugin,
          );
          if (isContentAddressedAssetBaseStorageUri(assetBaseStorageUri)) {
            const assetReferences =
              getContentAddressedManifestAssetStorageReferences({
                assetBaseStorageUri,
                manifest,
              });

            for (const assetReference of assetReferences) {
              try {
                const referenceFile = await loadContentAddressedAssetReference({
                  referenceStorageUri: assetReference.referenceStorageUri,
                  storagePlugin,
                });

                delete referenceFile.references[bundle.id];

                if (Object.keys(referenceFile.references).length === 0) {
                  addCleanupUri(assetReference.assetStorageUri);
                  addCleanupUri(assetReference.referenceStorageUri);
                  continue;
                }

                await uploadContentAddressedAssetReference({
                  referenceFile,
                  referenceStoragePath: assetReference.referenceStoragePath,
                  storagePlugin,
                });
              } catch (error) {
                console.error(
                  "Failed to resolve content-addressed asset reference for storage cleanup:",
                  error,
                );
              }
            }
          } else {
            const assetPaths = Object.keys(manifest.assets ?? {}).sort((a, b) =>
              a.localeCompare(b),
            );

            for (const assetPath of assetPaths) {
              addCleanupUri(
                createStorageUriWithRelativePath(
                  assetBaseStorageUri,
                  assetPath,
                ),
              );
            }
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
  };

  if (waitForStorageCleanup) {
    await cleanupStorage();
    return;
  }

  void cleanupStorage().catch((error) => {
    console.error("Failed to clean up bundle storage:", error);
  });
}
