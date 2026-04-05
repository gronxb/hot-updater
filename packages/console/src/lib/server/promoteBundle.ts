import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

import type { ConfigResponse } from "@hot-updater/cli-tools";
import {
  createTarBrTargetFiles,
  createTarGzTargetFiles,
  createZipTargetFiles,
} from "@hot-updater/cli-tools";
import type {
  Bundle,
  DatabasePlugin,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { detectCompressionFormat } from "@hot-updater/plugin-core";
import JSZip from "jszip";
import * as tar from "tar";

import { createUUIDv7 } from "../extract-timestamp-from-uuidv7";

const LEGACY_BUNDLE_ERROR =
  "This OTA bundle was created by a version that does not support manifest.json. Copy bundle is not available.";
const SIGNED_HASH_PREFIX = "sig:";

interface BundleManifest {
  bundleId?: string;
  assets?: Record<string, { fileHash: string }>;
}

export interface PromoteBundleInput {
  action: "copy" | "move";
  bundleId: string;
  nextBundleId?: string;
  targetChannel: string;
}

export interface PromoteBundleDependencies {
  config: ConfigResponse;
  databasePlugin: DatabasePlugin;
  storagePlugin: StoragePlugin | null;
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
  const { pathname } = new URL(storageUri);
  const filename = path.basename(pathname);
  return filename || "bundle.zip";
}

const getRelativeStorageDir = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, "/");
  const dirname = path.posix.dirname(normalized);
  return dirname === "." ? "" : dirname;
};

const replaceStorageUriLeaf = (storageUri: string, nextLeaf: string) => {
  const storageUrl = new URL(storageUri);
  const normalizedPath = storageUrl.pathname.replace(/\/+$/, "");
  const lastSlashIndex = normalizedPath.lastIndexOf("/");
  const parentPath =
    lastSlashIndex >= 0 ? normalizedPath.slice(0, lastSlashIndex) : "";

  storageUrl.pathname = `${parentPath}/${nextLeaf}`;
  return storageUrl.toString();
};

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

async function downloadArchive(fileUrl: string, archivePath: string) {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download bundle archive: ${response.statusText}`,
    );
  }

  const archiveBuffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(archivePath, archiveBuffer);
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

async function resolveBundleDownloadUrl(
  storageUri: string,
  storagePlugin: StoragePlugin | null,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (protocol === "http" || protocol === "https") {
    return storageUri;
  }

  if (!storagePlugin) {
    throw new Error("Storage plugin is not configured");
  }

  if (storagePlugin.supportedProtocol !== protocol) {
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  }

  const { fileUrl } = await storagePlugin.getDownloadUrl(storageUri);
  if (!fileUrl) {
    throw new Error("Storage plugin returned empty fileUrl");
  }

  return fileUrl;
}

export async function createCopiedBundleArchive({
  bundle,
  config,
  nextBundleId,
  storagePlugin,
  targetChannel,
}: {
  bundle: Bundle;
  config: ConfigResponse;
  nextBundleId: string;
  storagePlugin: StoragePlugin;
  targetChannel: string;
}) {
  const downloadUrl = await resolveBundleDownloadUrl(
    bundle.storageUri,
    storagePlugin,
  );
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
    await downloadArchive(downloadUrl, sourceArchivePath);
    const format = await extractArchive(sourceArchivePath, extractDir);

    const { manifest, manifestPath } = await rewriteManifestBundleId(
      extractDir,
      nextBundleId,
    );
    await fs.rm(sourceArchivePath, { force: true });
    await createArchiveFromDirectory(extractDir, outputArchivePath, format);

    const fileHash = await getFileHash(outputArchivePath);
    const manifestHash = await getFileHash(manifestPath);
    const requiresSigningKey = [
      bundle.fileHash,
      bundle.metadata?.manifest_file_hash,
    ]
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

    const archiveUpload = await storagePlugin.upload(
      nextBundleId,
      outputArchivePath,
    );
    uploadedStorageUris.push(archiveUpload.storageUri);
    const manifestUpload = await storagePlugin.upload(
      nextBundleId,
      manifestPath,
    );
    uploadedStorageUris.push(manifestUpload.storageUri);

    const assetPaths = Object.keys(manifest.assets ?? {}).sort((left, right) =>
      left.localeCompare(right),
    );

    for (const assetPath of assetPaths) {
      const relativeDir = getRelativeStorageDir(assetPath);
      const uploadKey = [nextBundleId, "files", relativeDir]
        .filter(Boolean)
        .join("/");
      const assetUpload = await storagePlugin.upload(
        uploadKey,
        path.join(extractDir, assetPath),
      );
      uploadedStorageUris.push(assetUpload.storageUri);
    }

    const assetBaseStorageUri = replaceStorageUriLeaf(
      manifestUpload.storageUri,
      "files",
    );

    return {
      bundle: {
        ...bundle,
        id: nextBundleId,
        channel: targetChannel,
        storageUri: archiveUpload.storageUri,
        fileHash: nextFileHash,
        metadata: {
          ...bundle.metadata,
          asset_base_storage_uri: assetBaseStorageUri,
          manifest_file_hash: nextManifestFileHash,
          manifest_storage_uri: manifestUpload.storageUri,
        },
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
  storagePlugin: StoragePlugin,
  storageUris: string[],
) {
  if (storageUris.length === 0) {
    return;
  }

  for (const storageUri of new Set(storageUris)) {
    try {
      await storagePlugin.delete(storageUri);
    } catch (error) {
      console.error("Failed to delete uploaded bundle copy:", error);
    }
  }
}

export async function promoteBundle(
  { action, bundleId, nextBundleId, targetChannel }: PromoteBundleInput,
  deps: PromoteBundleDependencies,
) {
  const normalizedTargetChannel = targetChannel.trim();
  if (!normalizedTargetChannel) {
    throw new Error("Target channel is required");
  }

  const bundle = await deps.databasePlugin.getBundleById(bundleId);
  if (!bundle) {
    throw new Error("Bundle not found");
  }

  if (bundle.channel === normalizedTargetChannel) {
    throw new Error(
      "Target channel must be different from the current channel",
    );
  }

  if (action === "move") {
    await deps.databasePlugin.updateBundle(bundleId, {
      channel: normalizedTargetChannel,
    });
    await deps.databasePlugin.commitBundle();

    const updatedBundle = await deps.databasePlugin.getBundleById(bundleId);
    if (!updatedBundle) {
      throw new Error("Promoted bundle not found");
    }

    return updatedBundle;
  }

  if (!deps.storagePlugin) {
    throw new Error("Storage plugin is not configured");
  }

  const resolvedNextBundleId = nextBundleId?.trim() || createUUIDv7();
  const { bundle: copiedBundle, uploadedStorageUris } =
    await createCopiedBundleArchive({
      bundle,
      config: deps.config,
      nextBundleId: resolvedNextBundleId,
      storagePlugin: deps.storagePlugin,
      targetChannel: normalizedTargetChannel,
    });
  let shouldCleanupUploadedCopy = true;

  try {
    await deps.databasePlugin.appendBundle(copiedBundle);
    await deps.databasePlugin.commitBundle();
    shouldCleanupUploadedCopy = false;
    return copiedBundle;
  } catch (error) {
    if (shouldCleanupUploadedCopy) {
      await deleteUploadedCopy(deps.storagePlugin, uploadedStorageUris);
    }
    throw error;
  }
}

export { LEGACY_BUNDLE_ERROR };
