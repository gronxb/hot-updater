import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createBrotliDecompress,
  constants as zlibConstants,
  createBrotliCompress,
  createGunzip,
} from "node:zlib";

import {
  getManifestFileHash,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type { Bundle, StoragePluginWith } from "@hot-updater/plugin-core";
import {
  assertBundleArchiveByteSize,
  assertBundleArtifactByteSize,
  assertBundleExpandedByteSize,
  assertBundleManifestByteSize,
  assertBundleTarStreamByteSize,
  createBundleStorageKey,
  createStorageRootUriWithPath,
  detectCompressionFormat,
  getPortableArtifactPathCollisionKey,
  getUtf8ByteSize,
  getManifestAssetDownloadPath,
  getManifestAssetStoragePath,
  isContentAddressedAssetFileHash,
  MAX_BUNDLE_ARCHIVE_ENTRIES,
  MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES,
  parseStorageUri,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";
import JSZip from "jszip";
import * as tar from "tar";

import { prepareBundleSigning } from "./bundleSigning";
import { createTarBrTargetFiles } from "./createTarBr";
import { createTarGzTargetFiles } from "./createTarGz";
import { createZipTargetFiles } from "./createZip";
import type { ConfigResponse } from "./loadConfig";
import { getStorageFileByteSize, putStorageFile } from "./storageFiles";

type PromoteStoragePlugin = StoragePluginWith<
  "get" | "put" | "exists" | "delete"
>;

const LEGACY_BUNDLE_ERROR =
  "This OTA bundle was created by a version that does not support manifest.json. Copy bundle is not available.";
const SIGNED_HASH_PREFIX = "sig:";
const PROMOTE_ASSET_CONCURRENCY = 8;

type ArchiveEntryKind = "directory" | "file";

interface ArchiveEntryDescriptor {
  kind: ArchiveEntryKind;
  path: string;
  size: number;
}

interface BundleManifest {
  bundleId?: string;
  assets?: Record<string, BundleManifestAsset>;
}

interface BundleManifestAsset {
  downloadByteSize?: number;
  downloadCompression?: "br" | null;
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

const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

function normalizeArchiveEntryPath(entryPath: string, kind: ArchiveEntryKind) {
  const normalized =
    kind === "directory" && entryPath.endsWith("/")
      ? entryPath.slice(0, -1)
      : entryPath;

  if (
    normalized.length === 0 ||
    normalized.includes("\\") ||
    normalized.includes(":") ||
    path.posix.isAbsolute(normalized) ||
    hasControlCharacter(normalized) ||
    getUtf8ByteSize(normalized) > MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    throw new Error(`Invalid archive entry path: ${entryPath}`);
  }

  return normalized;
}

function validateArchiveEntries(entries: readonly ArchiveEntryDescriptor[]) {
  const entriesByKey = new Map<
    string,
    { explicit: boolean; kind: ArchiveEntryKind; path: string }
  >();
  let expandedByteSize = 0;

  for (const entry of entries) {
    const normalizedPath = normalizeArchiveEntryPath(entry.path, entry.kind);
    const segments = normalizedPath.split("/");

    for (let index = 1; index < segments.length; index += 1) {
      const parentPath = segments.slice(0, index).join("/");
      const parentKey = getPortableArtifactPathCollisionKey(parentPath);
      const existingParent = entriesByKey.get(parentKey);
      if (existingParent?.kind === "file") {
        throw new Error(
          `Archive entry path conflicts with file: ${normalizedPath}`,
        );
      }
      if (existingParent && existingParent.path !== parentPath) {
        throw new Error(`Archive entry path collision: ${normalizedPath}`);
      }
      if (!existingParent) {
        entriesByKey.set(parentKey, {
          explicit: false,
          kind: "directory",
          path: parentPath,
        });
      }
    }

    const key = getPortableArtifactPathCollisionKey(normalizedPath);
    const existing = entriesByKey.get(key);
    if (
      existing?.explicit ||
      (existing &&
        (existing.kind !== "directory" || entry.kind !== "directory")) ||
      (existing && existing.path !== normalizedPath)
    ) {
      throw new Error(`Archive entry path collision: ${normalizedPath}`);
    }
    entriesByKey.set(key, {
      explicit: true,
      kind: entry.kind,
      path: normalizedPath,
    });

    if (entry.kind === "file") {
      assertBundleArtifactByteSize(entry.size, normalizedPath);
      if (normalizedPath === "manifest.json") {
        assertBundleManifestByteSize(entry.size);
      }
      expandedByteSize += entry.size;
      assertBundleExpandedByteSize(expandedByteSize);
    } else if (entry.size !== 0) {
      throw new Error(`Archive directory has data: ${normalizedPath}`);
    }

    if (entriesByKey.size > MAX_BUNDLE_ARCHIVE_ENTRIES) {
      throw new Error(
        `Bundle archive contains more than ${MAX_BUNDLE_ARCHIVE_ENTRIES} entries`,
      );
    }
  }
}

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
  downloadCompression,
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
    if (!manifest.assets?.[assetPath]?.fileHash) {
      throw new Error(`Manifest file hash not found for ${assetPath}`);
    }
  }

  if (
    assetPaths.some(
      (assetPath) =>
        manifest.assets?.[assetPath]?.downloadCompression === undefined,
    )
  ) {
    return [];
  }

  for (const assetPath of assetPaths) {
    const asset = manifest.assets?.[assetPath];
    if (!asset?.fileHash) {
      throw new Error(`Manifest file hash not found for ${assetPath}`);
    }
    const downloadCompression = asset.downloadCompression;
    if (downloadCompression === undefined) {
      return [];
    }

    const sourcePath = await resolveExtractedFilePath(extractDir, assetPath);
    const uploadSourcePath = await prepareManifestAssetUploadFile({
      assetPath,
      downloadCompression,
      sourcePath,
      workDir,
    });
    const downloadByteSize = await getStorageFileByteSize(uploadSourcePath);
    const downloadPath = getManifestAssetDownloadPath(
      assetPath,
      downloadCompression,
    );
    const usesBrotli = downloadCompression === "br";
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

function resolveExtractedPath(
  rootDir: string,
  entryName: string,
  kind: ArchiveEntryKind = "file",
) {
  const normalizedEntryName = normalizeArchiveEntryPath(entryName, kind);
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

async function resolveExtractedFilePath(rootDir: string, entryName: string) {
  const normalizedEntryName = normalizeArchiveEntryPath(entryName, "file");
  const segments = normalizedEntryName.split("/");
  let currentPath = rootDir;

  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]!);
    const entryStat = await fs.lstat(currentPath);
    if (index === segments.length - 1) {
      if (!entryStat.isFile()) {
        throw new Error(`Archive asset is not a regular file: ${entryName}`);
      }
    } else if (!entryStat.isDirectory()) {
      throw new Error(`Archive asset parent is not a directory: ${entryName}`);
    }
  }

  return currentPath;
}

function createByteLimitTransform(assertByteSize: (byteSize: number) => void) {
  let byteSize = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.byteLength;
      try {
        assertByteSize(byteSize);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

async function writeBoundedArchiveResponse(
  response: Response,
  filePath: string,
) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    assertBundleArchiveByteSize(Number(contentLength));
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (response.body === null) {
    await fs.writeFile(filePath, new Uint8Array());
    return;
  }

  try {
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      createByteLimitTransform(assertBundleArchiveByteSize),
      createWriteStream(filePath),
    );
  } catch (error) {
    await fs.rm(filePath, { force: true });
    throw error;
  }
}

async function downloadArchive(
  storageUri: string,
  storagePlugin: PromoteStoragePlugin | null,
  archivePath: string,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (storagePlugin?.protocol === protocol) {
    const { response } = await storagePlugin.get({ storageUri });
    if (response === null) {
      throw new Error(`Storage object not found: ${storageUri}`);
    }
    await writeBoundedArchiveResponse(response, archivePath);
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

  await writeBoundedArchiveResponse(response, filePath);
}

function readZipCentralDirectory(archive: Buffer) {
  const minimumEndOffset = Math.max(0, archive.byteLength - 65_557);
  let endOffset = -1;
  for (
    let offset = archive.byteLength - 22;
    offset >= minimumEndOffset;
    offset -= 1
  ) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset === -1) {
    throw new Error("Invalid ZIP central directory");
  }

  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);
  if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported");
  }

  const entries: ArchiveEntryDescriptor[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > archive.byteLength ||
      archive.readUInt32LE(offset) !== 0x02014b50
    ) {
      throw new Error("Invalid ZIP central directory entry");
    }
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    if (uncompressedSize === 0xffffffff) {
      throw new Error("ZIP64 entries are not supported");
    }
    const filenameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const filenameOffset = offset + 46;
    const nextOffset =
      filenameOffset + filenameLength + extraLength + commentLength;
    if (nextOffset > archive.byteLength) {
      throw new Error("Invalid ZIP central directory entry length");
    }
    const entryPath = archive
      .subarray(filenameOffset, filenameOffset + filenameLength)
      .toString("utf8");
    const madeBy = archive.readUInt16LE(offset + 4) >>> 8;
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const unixFileType =
      madeBy === 3 ? (externalAttributes >>> 16) & 0o170000 : 0;
    const kind: ArchiveEntryKind =
      entryPath.endsWith("/") || (externalAttributes & 0x10) !== 0
        ? "directory"
        : "file";
    if (
      (kind === "directory" &&
        unixFileType !== 0 &&
        unixFileType !== 0o040000) ||
      (kind === "file" && unixFileType !== 0 && unixFileType !== 0o100000)
    ) {
      throw new Error(`Unsupported ZIP entry type: ${entryPath}`);
    }
    entries.push({
      kind,
      path: entryPath,
      size: kind === "directory" ? 0 : uncompressedSize,
    });
    offset = nextOffset;
  }

  return entries;
}

async function extractZipArchive(archivePath: string, extractDir: string) {
  const archive = await fs.readFile(archivePath);
  const descriptors = readZipCentralDirectory(archive);
  validateArchiveEntries(descriptors);
  const zip = await JSZip.loadAsync(archive);

  for (const descriptor of descriptors) {
    const entry = zip.files[descriptor.path];
    if (!entry || entry.dir !== (descriptor.kind === "directory")) {
      throw new Error(`ZIP entry metadata mismatch: ${descriptor.path}`);
    }
    const outputPath = resolveExtractedPath(
      extractDir,
      descriptor.path,
      descriptor.kind,
    );

    if (descriptor.kind === "directory") {
      await fs.mkdir(outputPath, { recursive: true });
      continue;
    }

    const data = await entry.async("nodebuffer");
    if (data.byteLength !== descriptor.size) {
      throw new Error(`ZIP entry size mismatch: ${descriptor.path}`);
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, data);
  }
}

const getTarEntryDescriptor = (entry: {
  path: string;
  size: number;
  type: string;
}): ArchiveEntryDescriptor => {
  switch (entry.type) {
    case "File":
    case "OldFile":
      return { kind: "file", path: entry.path, size: entry.size };
    case "Directory":
      return { kind: "directory", path: entry.path, size: entry.size };
    default:
      throw new Error(`Unsupported TAR entry type: ${entry.type}`);
  }
};

async function extractTarArchive(tarPath: string, extractDir: string) {
  const entries: { path: string; size: number; type: string }[] = [];
  await tar.list({
    file: tarPath,
    onReadEntry(entry) {
      entries.push({ path: entry.path, size: entry.size, type: entry.type });
      entry.resume();
    },
    strict: true,
  });
  validateArchiveEntries(entries.map(getTarEntryDescriptor));

  await tar.extract({
    cwd: extractDir,
    file: tarPath,
    filter(_entryPath, entry) {
      if (!("path" in entry) || !("type" in entry)) {
        throw new Error("Invalid TAR archive entry");
      }
      getTarEntryDescriptor(entry);
      return true;
    },
    gzip: false,
    preservePaths: false,
    strict: true,
  });
}

async function decodeTarArchive(
  archivePath: string,
  tarPath: string,
  compression: "br" | "gzip",
) {
  await pipeline(
    createReadStream(archivePath),
    compression === "br" ? createBrotliDecompress() : createGunzip(),
    createByteLimitTransform(assertBundleTarStreamByteSize),
    createWriteStream(tarPath),
  );
  assertBundleTarStreamByteSize(await getStorageFileByteSize(tarPath));
}

async function getExtractedTreeEntries(
  rootDir: string,
  relativeDir = "",
): Promise<ArchiveEntryDescriptor[]> {
  const entries = await fs.readdir(path.join(rootDir, relativeDir), {
    withFileTypes: true,
  });
  const descriptors: ArchiveEntryDescriptor[] = [];

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    const entryPath = path.join(rootDir, relativePath);
    const entryStat = await fs.lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Archive contains a symbolic link: ${relativePath}`);
    }
    if (entryStat.isDirectory()) {
      descriptors.push({ kind: "directory", path: relativePath, size: 0 });
      descriptors.push(
        ...(await getExtractedTreeEntries(rootDir, relativePath)),
      );
      continue;
    }
    if (!entryStat.isFile()) {
      throw new Error(`Archive contains a non-regular entry: ${relativePath}`);
    }
    descriptors.push({
      kind: "file",
      path: relativePath,
      size: entryStat.size,
    });
  }

  return descriptors;
}

async function extractArchive(archivePath: string, extractDir: string) {
  const { format } = detectCompressionFormat(path.basename(archivePath));

  switch (format) {
    case "zip":
      await extractZipArchive(archivePath, extractDir);
      break;
    case "tar.gz":
    case "tar.br":
      {
        const tarPath = path.join(extractDir, ".hot-updater-source.tar");
        try {
          await decodeTarArchive(
            archivePath,
            tarPath,
            format === "tar.br" ? "br" : "gzip",
          );
          await extractTarArchive(tarPath, extractDir);
        } finally {
          await fs.rm(tarPath, { force: true });
        }
      }
      break;
  }

  validateArchiveEntries(await getExtractedTreeEntries(extractDir));
  return format;
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

async function readCopiedBundleManifest(
  extractDir: string,
  nextBundleId: string,
) {
  let manifestPath: string;

  try {
    manifestPath = await resolveExtractedFilePath(extractDir, "manifest.json");
  } catch {
    throw new Error(LEGACY_BUNDLE_ERROR);
  }

  assertBundleManifestByteSize(await getStorageFileByteSize(manifestPath));

  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as BundleManifest;

  manifest.bundleId = nextBundleId;

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
    assertBundleArchiveByteSize(
      await getStorageFileByteSize(sourceArchivePath),
    );
    const actualSourceFileHash = await getFileHash(sourceArchivePath);
    const signingSession = await prepareBundleSigning(config.signing);

    if (isSignedFileHash(bundle.fileHash)) {
      if (!signingSession) {
        throw new Error(
          "Cannot copy a signed bundle without enabled bundle signing configuration.",
        );
      }
      if (
        !verifySignedFileHash({
          actualFileHash: actualSourceFileHash,
          publicKey: signingSession.publicKey,
          signedFileHash: bundle.fileHash,
        })
      ) {
        throw new Error("Source bundle signature verification failed.");
      }
    } else if (actualSourceFileHash !== bundle.fileHash.toLowerCase()) {
      throw new Error("Source bundle file hash verification failed.");
    }

    const format = await extractArchive(sourceArchivePath, extractDir);

    const { manifest, manifestPath } = await readCopiedBundleManifest(
      extractDir,
      nextBundleId,
    );
    const assetPaths = Object.keys(manifest.assets ?? {}).sort((left, right) =>
      left.localeCompare(right),
    );
    const sourceIsSigned = [bundle.fileHash, getManifestFileHash(bundle)]
      .filter((hash): hash is string => Boolean(hash))
      .some((hash) => isSignedFileHash(hash));
    const manifestHasSignatures = assetPaths.some((assetPath) =>
      Boolean(manifest.assets?.[assetPath]?.signature),
    );

    if (!signingSession && (sourceIsSigned || manifestHasSignatures)) {
      throw new Error(
        "Cannot copy a signed bundle without enabled bundle signing configuration.",
      );
    }

    await runWithConcurrency(
      assetPaths,
      PROMOTE_ASSET_CONCURRENCY,
      async (assetPath) => {
        const asset = manifest.assets?.[assetPath];
        if (!asset?.fileHash) {
          throw new Error(`Manifest file hash not found for ${assetPath}`);
        }
        const sourcePath = await resolveExtractedFilePath(
          extractDir,
          assetPath,
        );
        const actualFileHash = await getFileHash(sourcePath);
        if (actualFileHash !== asset.fileHash.toLowerCase()) {
          throw new Error(`Manifest file hash mismatch for ${assetPath}`);
        }
      },
    );

    if (signingSession) {
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
    assertBundleManifestByteSize(await getStorageFileByteSize(manifestPath));
    await fs.rm(sourceArchivePath, { force: true });
    await createArchiveFromDirectory(extractDir, outputArchivePath, format);
    assertBundleArchiveByteSize(
      await getStorageFileByteSize(outputArchivePath),
    );

    const fileHash = await getFileHash(outputArchivePath);
    const manifestHash = await getFileHash(manifestPath);
    const nextFileHash = signingSession
      ? `${SIGNED_HASH_PREFIX}${await signingSession.signFileHash(fileHash)}`
      : fileHash;
    const nextManifestFileHash = signingSession
      ? `${SIGNED_HASH_PREFIX}${await signingSession.signFileHash(manifestHash)}`
      : manifestHash;

    const archiveUpload = await putStorageFile(
      storagePlugin,
      createBundleStorageKey(nextBundleId),
      outputArchivePath,
    );
    uploadedStorageUris.push(archiveUpload.storageUri);
    const assetBaseStorageUri = createStorageRootUriWithPath(
      archiveUpload.storageUri,
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

    const manifestUpload = await putStorageFile(
      storagePlugin,
      createBundleStorageKey(nextBundleId),
      manifestPath,
    );
    uploadedStorageUris.push(manifestUpload.storageUri);

    return {
      bundle: {
        ...bundle,
        id: nextBundleId,
        archiveByteSize: archiveUpload.byteSize,
        storageUri: archiveUpload.storageUri,
        fileHash: nextFileHash,
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
