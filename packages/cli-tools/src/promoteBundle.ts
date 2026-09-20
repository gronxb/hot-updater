import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  brotliDecompressSync,
  constants as zlibConstants,
  createBrotliCompress,
} from "node:zlib";

import {
  getManifestFileHash,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type { Bundle, StoragePluginWith } from "@hot-updater/plugin-core";
import {
  createBundleStorageKey,
  createStorageRootUriWithPath,
  getManifestAssetDownloadPath,
  getManifestAssetStoragePath,
  isContentAddressedAssetFileHash,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";

import { prepareBundleSigning } from "./bundleSigning";
import type { ConfigResponse } from "./loadConfig";
import {
  getStorageFileByteSize,
  putStorageFile,
  writeStorageFile,
  writeStorageResponseFile,
} from "./storageFiles";

type PromoteStoragePlugin = StoragePluginWith<
  "get" | "put" | "exists" | "delete"
>;

const LEGACY_BUNDLE_ERROR =
  "This OTA bundle was created by a version that does not support manifest.json. Copy bundle is not available.";
const SIGNED_HASH_PREFIX = "sig:";
const PROMOTE_ASSET_CONCURRENCY = 8;

interface BundleManifest {
  bundleId?: string;
  assets?: Record<string, BundleManifestAsset>;
}

interface BundleManifestAsset {
  downloadByteSize?: number;
  downloadFileHash?: string;
  fileHash: string;
  signature?: string;
}

interface PreparedAssetUploadTarget {
  assetPath: string;
  downloadFileHash?: string;
  fileHash: string;
  storagePath: string;
  uploadSourcePath: string;
}

function isSignedFileHash(fileHash: string) {
  return fileHash.startsWith(SIGNED_HASH_PREFIX);
}

async function getFileHash(filepath: string) {
  const file = await fs.readFile(filepath);
  return crypto.createHash("sha256").update(file).digest("hex");
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const itemIndex = nextIndex;
        nextIndex += 1;
        await task(items[itemIndex]!);
      }
    }),
  );
}

function verifySignedFileHash({
  actualFileHash,
  publicKey,
  signedFileHash,
}: {
  actualFileHash: string;
  publicKey: string;
  signedFileHash: string;
}) {
  try {
    return crypto.verify(
      "RSA-SHA256",
      Buffer.from(actualFileHash, "hex"),
      publicKey,
      Buffer.from(signedFileHash.slice(SIGNED_HASH_PREFIX.length), "base64"),
    );
  } catch {
    return false;
  }
}

const getRelativeStorageDir = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, "/");
  const dirname = path.posix.dirname(normalized);
  return dirname === "." ? "" : dirname;
};

function resolvePreparedUploadPath(rootDir: string, assetPath: string) {
  const normalizedAssetPath = assetPath.replaceAll("\\", "/");
  const outputPath = path.resolve(
    rootDir,
    "upload-artifacts",
    `${normalizedAssetPath}.br`,
  );
  const relativePath = path.relative(rootDir, outputPath);

  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    normalizedAssetPath.startsWith("/")
  ) {
    throw new Error(`Invalid manifest asset path: ${assetPath}`);
  }

  return outputPath;
}

async function prepareManifestAssetUploadFile({
  assetPath,
  sourcePath,
  workDir,
}: {
  assetPath: string;
  sourcePath: string;
  workDir: string;
}) {
  if (getManifestAssetDownloadPath(assetPath) === assetPath) {
    return sourcePath;
  }

  const uploadPath = resolvePreparedUploadPath(workDir, assetPath);
  await fs.mkdir(path.dirname(uploadPath), { recursive: true });
  await pipeline(
    createReadStream(sourcePath),
    createBrotliCompress({
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }),
    createWriteStream(uploadPath),
  );
  return uploadPath;
}

async function prepareContentAddressedUploadFile({
  sourcePath,
  storagePath,
  workDir,
}: {
  sourcePath: string;
  storagePath: string;
  workDir: string;
}) {
  const filename = path.posix.basename(storagePath);
  if (path.basename(sourcePath) === filename) {
    return sourcePath;
  }

  const uploadPath = path.join(
    workDir,
    "upload-artifacts",
    "content-addressed",
    filename,
  );
  await fs.mkdir(path.dirname(uploadPath), { recursive: true });
  await fs.copyFile(sourcePath, uploadPath);
  return uploadPath;
}

async function prepareManifestAssetUploadTargets({
  extractDir,
  manifest,
  workDir,
}: {
  extractDir: string;
  manifest: BundleManifest;
  workDir: string;
}) {
  const targets = new Map<string, PreparedAssetUploadTarget>();
  const assetPaths = Object.keys(manifest.assets ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );

  for (const assetPath of assetPaths) {
    const asset = manifest.assets?.[assetPath];
    if (!asset?.fileHash) {
      throw new Error(`Manifest file hash not found for ${assetPath}`);
    }

    const sourcePath = resolveExtractedPath(extractDir, assetPath);
    const uploadSourcePath = await prepareManifestAssetUploadFile({
      assetPath,
      sourcePath,
      workDir,
    });
    const downloadByteSize = await getStorageFileByteSize(uploadSourcePath);
    const downloadPath = getManifestAssetDownloadPath(assetPath);
    const usesBrotli = downloadPath !== assetPath;
    const downloadFileHash = usesBrotli
      ? await getFileHash(uploadSourcePath)
      : undefined;
    if (
      downloadFileHash !== undefined &&
      !isContentAddressedAssetFileHash(downloadFileHash)
    ) {
      throw new Error(
        `Prepared asset hash must be a lowercase SHA-256 hash: ${assetPath}`,
      );
    }

    const nextAsset: BundleManifestAsset = {
      ...asset,
      downloadByteSize,
    };
    delete nextAsset.downloadFileHash;
    if (downloadFileHash !== undefined) {
      nextAsset.downloadFileHash = downloadFileHash;
    }
    manifest.assets![assetPath] = nextAsset;

    const storagePath = getManifestAssetStoragePath({
      assetPath: downloadPath,
      downloadFileHash,
      fileHash: asset.fileHash,
    });
    const contentAddressedUploadPath = await prepareContentAddressedUploadFile({
      sourcePath: uploadSourcePath,
      storagePath,
      workDir,
    });
    targets.set(storagePath, {
      assetPath: downloadPath,
      downloadFileHash,
      fileHash: asset.fileHash,
      storagePath,
      uploadSourcePath: contentAddressedUploadPath,
    });
  }

  return [...targets.values()];
}

function resolveExtractedPath(rootDir: string, entryName: string) {
  const normalizedEntryName = entryName.replaceAll("\\", "/");
  const entryPath = path.resolve(rootDir, normalizedEntryName);
  const relativePath = path.relative(rootDir, entryPath);

  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    normalizedEntryName.startsWith("/")
  ) {
    throw new Error(`Invalid manifest asset path: ${entryName}`);
  }

  return entryPath;
}

async function downloadStorageObject(
  storageUri: string,
  storagePlugin: PromoteStoragePlugin | null,
  outputPath: string,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (storagePlugin?.protocol === protocol) {
    await writeStorageFile(storagePlugin, storageUri, outputPath);
    return;
  }

  if (protocol === "http" || protocol === "https") {
    await downloadFromUrl(storageUri, outputPath);
    return;
  }

  throw new Error(`No storage plugin for protocol: ${protocol}`);
}

async function downloadFromUrl(fileUrl: string, filePath: string) {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download storage object: ${response.statusText}`,
    );
  }

  await writeStorageResponseFile(response, filePath);
}

async function downloadManifestAssets({
  bundle,
  manifest,
  outputDir,
  storagePlugin,
  workDir,
}: {
  bundle: Bundle;
  manifest: BundleManifest;
  outputDir: string;
  storagePlugin: PromoteStoragePlugin;
  workDir: string;
}) {
  const assetPaths = Object.keys(manifest.assets ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );

  await runWithConcurrency(
    assetPaths,
    PROMOTE_ASSET_CONCURRENCY,
    async (assetPath) => {
      const asset = manifest.assets?.[assetPath];
      if (!asset?.fileHash) {
        throw new Error(`Manifest file hash not found for ${assetPath}`);
      }
      const downloadPath = getManifestAssetDownloadPath(assetPath);
      const storageUri = resolveManifestAssetStorageUri({
        assetBaseStorageUri: bundle.assetBaseStorageUri,
        assetPath: downloadPath,
        downloadFileHash: asset.downloadFileHash,
        fileHash: asset.fileHash,
      });
      const transferPath = resolveExtractedPath(
        workDir,
        `downloads/${downloadPath}`,
      );
      await fs.mkdir(path.dirname(transferPath), { recursive: true });
      await downloadStorageObject(storageUri, storagePlugin, transferPath);

      if (asset.downloadFileHash) {
        const actualDownloadHash = await getFileHash(transferPath);
        if (actualDownloadHash !== asset.downloadFileHash.toLowerCase()) {
          throw new Error(`Manifest download hash mismatch for ${assetPath}`);
        }
      }

      const outputPath = resolveExtractedPath(outputDir, assetPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      if (downloadPath === assetPath) {
        await fs.copyFile(transferPath, outputPath);
      } else {
        await fs.writeFile(
          outputPath,
          brotliDecompressSync(await fs.readFile(transferPath)),
        );
      }

      const actualFileHash = await getFileHash(outputPath);
      if (actualFileHash !== asset.fileHash.toLowerCase()) {
        throw new Error(`Manifest file hash mismatch for ${assetPath}`);
      }
    },
  );
}

export async function createCopiedBundleArtifacts({
  bundle,
  config,
  nextBundleId,
  storagePlugin,
}: {
  bundle: Bundle;
  config: ConfigResponse;
  nextBundleId: string;
  storagePlugin: PromoteStoragePlugin;
}) {
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-console-promote-"),
  );
  const extractDir = path.join(workDir, "bundle");
  const sourceManifestPath = path.join(workDir, "source-manifest.json");
  const manifestPath = path.join(extractDir, "manifest.json");
  const uploadedStorageUris: string[] = [];

  await fs.mkdir(extractDir, { recursive: true });

  try {
    await downloadStorageObject(
      bundle.manifestStorageUri,
      storagePlugin,
      sourceManifestPath,
    );
    const actualManifestHash = await getFileHash(sourceManifestPath);
    const signingSession = await prepareBundleSigning(config.signing);

    if (isSignedFileHash(bundle.manifestFileHash)) {
      if (!signingSession) {
        throw new Error(
          "Cannot copy a signed bundle without enabled bundle signing configuration.",
        );
      }
      if (
        !verifySignedFileHash({
          actualFileHash: actualManifestHash,
          publicKey: signingSession.publicKey,
          signedFileHash: bundle.manifestFileHash,
        })
      ) {
        throw new Error("Source manifest signature verification failed.");
      }
    } else if (actualManifestHash !== bundle.manifestFileHash.toLowerCase()) {
      throw new Error("Source manifest file hash verification failed.");
    }

    const manifest = JSON.parse(
      await fs.readFile(sourceManifestPath, "utf8"),
    ) as BundleManifest;
    if (!manifest.assets || typeof manifest.assets !== "object") {
      throw new Error(LEGACY_BUNDLE_ERROR);
    }
    await downloadManifestAssets({
      bundle,
      manifest,
      outputDir: extractDir,
      storagePlugin,
      workDir,
    });
    manifest.bundleId = nextBundleId;
    const assetPaths = Object.keys(manifest.assets ?? {}).sort((left, right) =>
      left.localeCompare(right),
    );
    const sourceIsSigned = isSignedFileHash(getManifestFileHash(bundle));
    const manifestHasSignatures = assetPaths.some((assetPath) =>
      Boolean(manifest.assets?.[assetPath]?.signature),
    );

    if (!signingSession && (sourceIsSigned || manifestHasSignatures)) {
      throw new Error(
        "Cannot copy a signed bundle without enabled bundle signing configuration.",
      );
    }

    if (signingSession) {
      await runWithConcurrency(
        assetPaths,
        PROMOTE_ASSET_CONCURRENCY,
        async (assetPath) => {
          const asset = manifest.assets?.[assetPath];
          if (!asset?.fileHash) {
            throw new Error(`Manifest file hash not found for ${assetPath}`);
          }
          const sourcePath = resolveExtractedPath(extractDir, assetPath);
          const actualFileHash = await getFileHash(sourcePath);
          if (actualFileHash !== asset.fileHash.toLowerCase()) {
            throw new Error(`Manifest file hash mismatch for ${assetPath}`);
          }
        },
      );
      await runWithConcurrency(
        assetPaths,
        PROMOTE_ASSET_CONCURRENCY,
        async (assetPath) => {
          const asset = manifest.assets?.[assetPath];
          if (!asset?.fileHash) {
            throw new Error(`Manifest file hash not found for ${assetPath}`);
          }
          asset.signature = await signingSession.signFileHash(asset.fileHash);
        },
      );
    }

    const assetUploadTargets = await prepareManifestAssetUploadTargets({
      extractDir,
      manifest,
      workDir,
    });
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const manifestHash = await getFileHash(manifestPath);
    const nextManifestFileHash = signingSession
      ? `${SIGNED_HASH_PREFIX}${await signingSession.signFileHash(manifestHash)}`
      : manifestHash;

    const manifestUpload = await putStorageFile(
      storagePlugin,
      createBundleStorageKey(nextBundleId),
      manifestPath,
    );
    uploadedStorageUris.push(manifestUpload.storageUri);
    const assetBaseStorageUri = createStorageRootUriWithPath(
      manifestUpload.storageUri,
      nextBundleId,
      "assets",
    );

    for (const assetUploadTarget of assetUploadTargets) {
      const storageUri = resolveManifestAssetStorageUri({
        assetBaseStorageUri,
        assetPath: assetUploadTarget.assetPath,
        downloadFileHash: assetUploadTarget.downloadFileHash,
        fileHash: assetUploadTarget.fileHash,
      });

      const { exists } = await storagePlugin.exists({ storageUri });
      if (!exists) {
        await putStorageFile(
          storagePlugin,
          getRelativeStorageDir(assetUploadTarget.storagePath)
            ? `assets/${getRelativeStorageDir(assetUploadTarget.storagePath)}`
            : "assets",
          assetUploadTarget.uploadSourcePath,
        );
      }
    }

    return {
      bundle: {
        ...bundle,
        id: nextBundleId,
        metadata: stripBundleArtifactMetadata(bundle.metadata),
        assetBaseStorageUri,
        patches: [],
        manifestFileHash: nextManifestFileHash,
        manifestStorageUri: manifestUpload.storageUri,
      } satisfies Bundle,
      uploadedStorageUris,
    };
  } catch (error) {
    await deleteUploadedCopy(storagePlugin, uploadedStorageUris);
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function deleteUploadedCopy(
  storagePlugin: PromoteStoragePlugin,
  storageUris: string[],
) {
  if (storageUris.length === 0) {
    return;
  }

  for (const storageUri of new Set(storageUris)) {
    try {
      const protocol = new URL(storageUri).protocol.replace(":", "");
      if (storagePlugin.protocol === protocol) {
        await storagePlugin.delete({ storageUri });
      } else if (protocol !== "http" && protocol !== "https") {
        throw new Error(`No storage plugin for protocol: ${protocol}`);
      }
    } catch (error) {
      console.error("Failed to delete uploaded bundle copy:", error);
    }
  }
}

export { LEGACY_BUNDLE_ERROR };
