import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createBrotliCompress, brotliDecompressSync } from "node:zlib";

import {
  getManifestFileHash,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type { Bundle, StoragePluginWith } from "@hot-updater/plugin-core";
import {
  createBundleStorageKey,
  createStorageRootUriWithPath,
  detectCompressionFormat,
  getContentAddressedAssetStoragePath,
  getManifestAssetDownloadPath,
  parseStorageUri,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";
import JSZip from "jszip";
import * as tar from "tar";

import { createTarBrTargetFiles } from "./createTarBr";
import { createTarGzTargetFiles } from "./createTarGz";
import { createZipTargetFiles } from "./createZip";
import type { ConfigResponse } from "./loadConfig";
import {
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

interface BundleManifest {
  bundleId?: string;
  assets?: Record<string, { fileHash: string; signature?: string }>;
}

function isSignedFileHash(fileHash: string) {
  return fileHash.startsWith(SIGNED_HASH_PREFIX);
}

async function getFileHash(filepath: string) {
  const file = await fs.readFile(filepath);
  return crypto.createHash("sha256").update(file).digest("hex");
}

async function signFileHash(fileHash: string, privateKeyPath: string) {
  const privateKeyPEM = await fs.readFile(privateKeyPath, "utf8");
  const sign = crypto.createSign("RSA-SHA256");

  sign.update(Buffer.from(fileHash, "hex"));
  sign.end();

  return `${SIGNED_HASH_PREFIX}${sign.sign(privateKeyPEM).toString("base64")}`;
}

function getArchiveFilename(storageUri: string) {
  const protocol = new URL(storageUri).protocol.replace(":", "");
  const { key } = parseStorageUri(storageUri, protocol);
  const filename = path.posix.basename(key);
  return filename || "bundle.zip";
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
    createBrotliCompress(),
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

function resolveExtractedPath(rootDir: string, entryName: string) {
  const normalizedEntryName = entryName.replaceAll("\\", "/");
  const entryPath = path.resolve(rootDir, normalizedEntryName);
  const relativePath = path.relative(rootDir, entryPath);

  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    normalizedEntryName.startsWith("/")
  ) {
    throw new Error(`Invalid archive entry path: ${entryName}`);
  }

  return entryPath;
}

async function downloadArchive(
  storageUri: string,
  storagePlugin: PromoteStoragePlugin | null,
  archivePath: string,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (storagePlugin?.protocol === protocol) {
    await writeStorageFile(storagePlugin, storageUri, archivePath);
    return;
  }

  if (protocol === "http" || protocol === "https") {
    await downloadFromUrl(storageUri, archivePath);
    return;
  }

  throw new Error(`No storage plugin for protocol: ${protocol}`);
}

async function downloadFromUrl(fileUrl: string, filePath: string) {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download bundle archive: ${response.statusText}`,
    );
  }

  await writeStorageResponseFile(response, filePath);
}

async function extractZipArchive(archivePath: string, extractDir: string) {
  const zip = await JSZip.loadAsync(await fs.readFile(archivePath));
  const entries = Object.values(zip.files).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const outputPath = resolveExtractedPath(extractDir, entry.name);

    if (entry.dir) {
      await fs.mkdir(outputPath, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, await entry.async("nodebuffer"));
  }
}

async function extractTarBrArchive(archivePath: string, extractDir: string) {
  const tarPath = path.join(extractDir, "bundle.tar");
  const compressedBuffer = await fs.readFile(archivePath);
  const tarBuffer = brotliDecompressSync(compressedBuffer);

  await fs.writeFile(tarPath, tarBuffer);

  try {
    await tar.extract({
      file: tarPath,
      cwd: extractDir,
      gzip: false,
      strict: true,
    });
  } finally {
    await fs.rm(tarPath, { force: true });
  }
}

async function extractArchive(archivePath: string, extractDir: string) {
  const { format } = detectCompressionFormat(path.basename(archivePath));

  switch (format) {
    case "zip":
      await extractZipArchive(archivePath, extractDir);
      return format;
    case "tar.gz":
      await tar.extract({
        file: archivePath,
        cwd: extractDir,
        gzip: true,
        strict: true,
      });
      return format;
    case "tar.br":
      await extractTarBrArchive(archivePath, extractDir);
      return format;
  }
}

async function getArchiveTargetFiles(bundleDir: string) {
  const entries = await fs.readdir(bundleDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  return entries.map((entry) => ({
    path: path.join(bundleDir, entry.name),
    name: entry.name,
  }));
}

async function createArchiveFromDirectory(
  sourceDir: string,
  archivePath: string,
  format: ReturnType<typeof detectCompressionFormat>["format"],
) {
  const targetFiles = await getArchiveTargetFiles(sourceDir);

  switch (format) {
    case "zip":
      await createZipTargetFiles({
        outfile: archivePath,
        targetFiles,
      });
      return;
    case "tar.gz":
      await createTarGzTargetFiles({
        outfile: archivePath,
        targetFiles,
      });
      return;
    case "tar.br":
      await createTarBrTargetFiles({
        outfile: archivePath,
        targetFiles,
      });
      return;
  }
}

async function rewriteManifestBundleId(
  extractDir: string,
  nextBundleId: string,
) {
  const manifestPath = path.join(extractDir, "manifest.json");

  try {
    await fs.access(manifestPath);
  } catch {
    throw new Error(LEGACY_BUNDLE_ERROR);
  }

  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as BundleManifest;

  manifest.bundleId = nextBundleId;

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    manifestPath,
  };
}

export async function createCopiedBundleArchive({
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
  // Re-upload follows deploy.ts after build: repackage, hash/sign, upload.
  const archiveFilename = getArchiveFilename(bundle.storageUri);
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-console-promote-"),
  );
  const sourceArchivePath = path.join(workDir, archiveFilename);
  const extractDir = path.join(workDir, "bundle");
  const outputArchivePath = path.join(workDir, archiveFilename);
  const uploadedStorageUris: string[] = [];

  await fs.mkdir(extractDir, { recursive: true });

  try {
    await downloadArchive(bundle.storageUri, storagePlugin, sourceArchivePath);
    const format = await extractArchive(sourceArchivePath, extractDir);

    const { manifest, manifestPath } = await rewriteManifestBundleId(
      extractDir,
      nextBundleId,
    );
    await fs.rm(sourceArchivePath, { force: true });
    await createArchiveFromDirectory(extractDir, outputArchivePath, format);

    const fileHash = await getFileHash(outputArchivePath);
    const manifestHash = await getFileHash(manifestPath);
    const requiresSigningKey = [bundle.fileHash, getManifestFileHash(bundle)]
      .filter((hash): hash is string => Boolean(hash))
      .some((hash) => isSignedFileHash(hash));

    if (requiresSigningKey && !config.signing?.privateKeyPath) {
      throw new Error(
        "Cannot copy a signed bundle without signing.privateKeyPath in hot-updater.config.ts",
      );
    }

    const signingKeyPath =
      config.signing?.enabled && config.signing.privateKeyPath
        ? config.signing.privateKeyPath
        : null;
    const nextFileHash = signingKeyPath
      ? await signFileHash(fileHash, signingKeyPath)
      : fileHash;
    const nextManifestFileHash = signingKeyPath
      ? await signFileHash(manifestHash, signingKeyPath)
      : manifestHash;

    const archiveUpload = await putStorageFile(
      storagePlugin,
      createBundleStorageKey(nextBundleId),
      outputArchivePath,
    );
    uploadedStorageUris.push(archiveUpload.storageUri);
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

    const assetPaths = Object.keys(manifest.assets ?? {}).sort((left, right) =>
      left.localeCompare(right),
    );

    for (const assetPath of assetPaths) {
      const asset = manifest.assets?.[assetPath];
      if (!asset?.fileHash) {
        throw new Error(`Manifest file hash not found for ${assetPath}`);
      }
      const sourcePath = path.join(extractDir, assetPath);
      const uploadPath = await prepareManifestAssetUploadFile({
        assetPath,
        sourcePath,
        workDir,
      });
      const uploadName = getManifestAssetDownloadPath(assetPath);
      const storagePath = getContentAddressedAssetStoragePath({
        assetPath: uploadName,
        fileHash: asset.fileHash,
      });
      const storageUri = resolveManifestAssetStorageUri({
        assetBaseStorageUri,
        assetPath: uploadName,
        fileHash: asset.fileHash,
      });

      const { exists } = await storagePlugin.exists({ storageUri });
      if (!exists) {
        const contentAddressedUploadPath =
          await prepareContentAddressedUploadFile({
            sourcePath: uploadPath,
            storagePath,
            workDir,
          });
        await putStorageFile(
          storagePlugin,
          getRelativeStorageDir(storagePath)
            ? `assets/${getRelativeStorageDir(storagePath)}`
            : "assets",
          contentAddressedUploadPath,
        );
      }
    }

    return {
      bundle: {
        ...bundle,
        id: nextBundleId,
        storageUri: archiveUpload.storageUri,
        fileHash: nextFileHash,
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
