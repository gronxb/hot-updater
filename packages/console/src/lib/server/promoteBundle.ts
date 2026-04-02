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

  await fs.mkdir(extractDir, { recursive: true });

  try {
    await downloadArchive(downloadUrl, sourceArchivePath);
    const format = await extractArchive(sourceArchivePath, extractDir);

    await rewriteManifestBundleId(extractDir, nextBundleId);
    await fs.rm(sourceArchivePath, { force: true });
    await createArchiveFromDirectory(extractDir, outputArchivePath, format);

    const fileHash = await getFileHash(outputArchivePath);
    const shouldKeepSignedHash =
      isSignedFileHash(bundle.fileHash) && !config.signing?.enabled;

    if (shouldKeepSignedHash) {
      throw new Error(
        "Cannot copy a signed bundle without signing.privateKeyPath in hot-updater.config.ts",
      );
    }

    const nextFileHash =
      config.signing?.enabled && config.signing.privateKeyPath
        ? await signFileHash(fileHash, config.signing.privateKeyPath)
        : fileHash;

    const { storageUri } = await storagePlugin.upload(
      nextBundleId,
      outputArchivePath,
    );

    return {
      ...bundle,
      id: nextBundleId,
      channel: targetChannel,
      storageUri,
      fileHash: nextFileHash,
    } satisfies Bundle;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function deleteUploadedCopy(
  storagePlugin: StoragePlugin,
  storageUri: string | null,
) {
  if (!storageUri) {
    return;
  }

  try {
    await storagePlugin.delete(storageUri);
  } catch (error) {
    console.error("Failed to delete uploaded bundle copy:", error);
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
  const copiedBundle = await createCopiedBundleArchive({
    bundle,
    config: deps.config,
    nextBundleId: resolvedNextBundleId,
    storagePlugin: deps.storagePlugin,
    targetChannel: normalizedTargetChannel,
  });
  let uploadedStorageUri: string | null = copiedBundle.storageUri;

  try {
    await deps.databasePlugin.appendBundle(copiedBundle);
    await deps.databasePlugin.commitBundle();
    uploadedStorageUri = null;
    return copiedBundle;
  } catch (error) {
    await deleteUploadedCopy(deps.storagePlugin, uploadedStorageUri);
    throw error;
  }
}

export { LEGACY_BUNDLE_ERROR };
