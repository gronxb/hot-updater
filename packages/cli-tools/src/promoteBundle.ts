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

import type { Bundle, StorageAdapterWith } from "@hot-updater/plugin-core";
import {
  createBundleStorageKey,
  createStorageRootUriWithPath,
  getManifestAssetDownloadPath,
  getManifestAssetStoragePath,
  isContentAddressedAssetFileHash,
  resolveManifestAssetStorageUri,
  parseStoredBundleManifest,
  hasVerifiedDownloadRepresentation,
  assertBundleArtifactByteSize,
  assertBundleExpandedByteSize,
  assertBundleManifestByteSize,
  MAX_BUNDLE_ARTIFACT_BYTES,
  MAX_BUNDLE_MANIFEST_BYTES,
} from "@hot-updater/plugin-core";
import {
  getManifestFileHash,
  type ManifestArchive,
  stripBundleArtifactMetadata,
} from "@hot-updater/protocol";

import { prepareBundleSigning } from "./bundleSigning";
import { createTarBrTargetFiles } from "./createTarBr";
import type { ConfigResponse } from "./loadConfig";
import {
  getStorageFileByteSize,
  putStorageFile,
  writeStorageFile,
  writeStorageResponseFile,
} from "./storageFiles";

type PromoteStorageAdapter = StorageAdapterWith<
  "get" | "put" | "exists" | "delete"
>;

const LEGACY_BUNDLE_ERROR =
  "This OTA bundle was created by a version that does not support manifest.json. Copy bundle is not available.";
const SIGNED_HASH_PREFIX = "sig:";
const PROMOTE_ASSET_CONCURRENCY = 8;

interface BundleManifest {
  bundleId?: string;
  assets?: Record<string, BundleManifestAsset>;
  archive?: ManifestArchive;
}

interface BundleManifestAsset {
  byteSize?: number;
  downloadByteSize?: number;
  downloadFileHash?: string;
  fileHash: string;
  downloadCompression?: "br" | null;
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
  downloadCompression,
  assetPath,
  sourcePath,
  workDir,
}: {
  assetPath: string;
  downloadCompression: "br" | null;
  sourcePath: string;
  workDir: string;
}) {
  if (
    getManifestAssetDownloadPath(assetPath, downloadCompression) === assetPath
  ) {
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

    if (asset.downloadCompression === undefined)
      throw new Error(
        `Manifest asset does not declare downloadCompression: ${assetPath}`,
      );
    const sourcePath = resolveExtractedPath(extractDir, assetPath);
    const uploadSourcePath = await prepareManifestAssetUploadFile({
      downloadCompression: asset.downloadCompression,
      assetPath,
      sourcePath,
      workDir,
    });
    const downloadByteSize = await getStorageFileByteSize(uploadSourcePath);
    const downloadPath = getManifestAssetDownloadPath(
      assetPath,
      asset.downloadCompression ?? null,
    );
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
      byteSize: (await fs.stat(sourcePath)).size,
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
  storageAdapter: PromoteStorageAdapter | null,
  outputPath: string,
  maxBytes = MAX_BUNDLE_ARTIFACT_BYTES,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (storageAdapter?.protocol === protocol) {
    await writeStorageFile(storageAdapter, storageUri, outputPath, maxBytes);
    return;
  }

  if (protocol === "http" || protocol === "https") {
    await downloadFromUrl(storageUri, outputPath, maxBytes);
    return;
  }

  throw new Error(`No storage adapter for protocol: ${protocol}`);
}

async function downloadFromUrl(
  fileUrl: string,
  filePath: string,
  maxBytes: number,
) {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download storage object: ${response.statusText}`,
    );
  }

  await writeStorageResponseFile(response, filePath, maxBytes);
}

async function downloadManifestAssets({
  bundle,
  manifest,
  outputDir,
  storageAdapter,
  workDir,
}: {
  bundle: Bundle;
  manifest: BundleManifest;
  outputDir: string;
  storageAdapter: PromoteStorageAdapter;
  workDir: string;
}) {
  const assetPaths = Object.keys(manifest.assets ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );

  let expandedByteSize = 0;
  await runWithConcurrency(
    assetPaths,
    PROMOTE_ASSET_CONCURRENCY,
    async (assetPath) => {
      const asset = manifest.assets?.[assetPath];
      if (!asset?.fileHash) {
        throw new Error(`Manifest file hash not found for ${assetPath}`);
      }
      const downloadPath = getManifestAssetDownloadPath(
        assetPath,
        asset.downloadCompression ?? null,
      );
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
      await downloadStorageObject(storageUri, storageAdapter, transferPath);
      const transferBytes = await fs.readFile(transferPath);
      if (!hasVerifiedDownloadRepresentation(asset, transferBytes)) {
        throw new Error(
          `Manifest download representation mismatch for ${assetPath}`,
        );
      }

      const outputPath = resolveExtractedPath(outputDir, assetPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      if (downloadPath === assetPath) {
        await fs.copyFile(transferPath, outputPath);
      } else {
        await fs.writeFile(
          outputPath,
          brotliDecompressSync(transferBytes, {
            maxOutputLength: MAX_BUNDLE_ARTIFACT_BYTES,
          }),
        );
      }

      const actualFileHash = await getFileHash(outputPath);
      if (actualFileHash !== asset.fileHash.toLowerCase()) {
        throw new Error(`Manifest file hash mismatch for ${assetPath}`);
      }
      const logicalSize = (await fs.stat(outputPath)).size;
      assertBundleArtifactByteSize(logicalSize, assetPath);
      expandedByteSize += logicalSize;
      assertBundleExpandedByteSize(expandedByteSize);
    },
  );
}

export async function createCopiedBundleArtifacts({
  bundle,
  config,
  nextBundleId,
  storageAdapter,
}: {
  bundle: Bundle;
  config: ConfigResponse;
  nextBundleId: string;
  storageAdapter: PromoteStorageAdapter;
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
      storageAdapter,
      sourceManifestPath,
      MAX_BUNDLE_MANIFEST_BYTES,
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

    const manifest = parseStoredBundleManifest({
      bundleId: bundle.id,
      manifestBytes: await fs.readFile(sourceManifestPath),
      manifestContentHash: actualManifestHash,
    });
    if (!manifest) {
      throw new Error(LEGACY_BUNDLE_ERROR);
    }
    await downloadManifestAssets({
      bundle,
      manifest,
      outputDir: extractDir,
      storageAdapter,
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
    const archivePath = path.join(workDir, "bundle.tar.br");
    manifest.archive = await createTarBrTargetFiles({
      outfile: archivePath,
      targetFiles: assetPaths.map((name) => ({
        name,
        path: resolveExtractedPath(extractDir, name),
      })),
    });
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assertBundleManifestByteSize(await getStorageFileByteSize(manifestPath));

    const manifestHash = await getFileHash(manifestPath);
    const nextManifestFileHash = signingSession
      ? `${SIGNED_HASH_PREFIX}${await signingSession.signFileHash(manifestHash)}`
      : manifestHash;

    const archiveUpload = await putStorageFile(
      storageAdapter,
      createBundleStorageKey(nextBundleId),
      archivePath,
    );
    uploadedStorageUris.push(archiveUpload.storageUri);
    const manifestUpload = await putStorageFile(
      storageAdapter,
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

      const { exists } = await storageAdapter.exists({ storageUri });
      if (!exists) {
        await putStorageFile(
          storageAdapter,
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
        metadata: {
          ...stripBundleArtifactMetadata(bundle.metadata),
          manifest_content_hash: manifestHash,
        },
        assetBaseStorageUri,
        patches: [],
        manifestFileHash: nextManifestFileHash,
        manifestStorageUri: manifestUpload.storageUri,
      } satisfies Bundle,
      uploadedStorageUris,
    };
  } catch (error) {
    await deleteUploadedCopy(storageAdapter, uploadedStorageUris);
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function deleteUploadedCopy(
  storageAdapter: PromoteStorageAdapter,
  storageUris: string[],
) {
  if (storageUris.length === 0) {
    return;
  }

  for (const storageUri of new Set(storageUris)) {
    try {
      const protocol = new URL(storageUri).protocol.replace(":", "");
      if (storageAdapter.protocol === protocol) {
        await storageAdapter.delete({ storageUri });
      } else if (protocol !== "http" && protocol !== "https") {
        throw new Error(`No storage adapter for protocol: ${protocol}`);
      }
    } catch (error) {
      console.error("Failed to delete uploaded bundle copy:", error);
    }
  }
}

export { LEGACY_BUNDLE_ERROR };
