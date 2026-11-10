import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { createBrotliCompress, constants as zlibConstants } from "zlib";

import { getStorageFileByteSize, putStorageFile } from "@hot-updater/cli-tools";
import type { StorageAdapterWith } from "@hot-updater/plugin-core";
import {
  createStorageUriWithRelativePath,
  getManifestAssetDownloadPath,
  getManifestAssetStoragePath,
  isContentAddressedAssetFileHash,
} from "@hot-updater/plugin-core";

import type { Manifest } from "./bundleManifest";
import { getFileHashFromFile } from "./getFileHash";

export const MANIFEST_ASSET_UPLOAD_CONCURRENCY = 8;

export const runWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
) => {
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
};

export const getRelativeStorageDir = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, "/");
  const dirname = path.posix.dirname(normalized);
  return dirname === "." ? "" : dirname;
};

export type ManifestTargetFile = { path: string; name: string };

export type PreparedAssetUploadTarget = {
  storagePath: string;
  uploadSourcePath: string;
};

const prepareManifestAssetUploadFile = async ({
  outputPath,
  targetFile,
}: {
  outputPath: string;
  targetFile: ManifestTargetFile;
}) => {
  const uploadName = getManifestAssetDownloadPath(targetFile.name);
  const expectedFilename = path.posix.basename(uploadName);
  const actualFilename = path.basename(targetFile.path);

  if (uploadName === targetFile.name && expectedFilename === actualFilename) {
    return targetFile.path;
  }

  const aliasDir = path.join(
    outputPath,
    "upload-artifacts",
    getRelativeStorageDir(uploadName),
  );
  await fs.promises.mkdir(aliasDir, { recursive: true });

  const aliasPath = path.join(aliasDir, expectedFilename);
  if (uploadName !== targetFile.name) {
    await pipeline(
      fs.createReadStream(targetFile.path),
      createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        },
      }),
      fs.createWriteStream(aliasPath),
    );
  } else {
    await fs.promises.copyFile(targetFile.path, aliasPath);
  }
  return aliasPath;
};

const prepareContentAddressedUploadFile = async ({
  outputPath,
  sourcePath,
  storagePath,
}: {
  outputPath: string;
  sourcePath: string;
  storagePath: string;
}) => {
  const filename = path.posix.basename(storagePath);
  if (path.basename(sourcePath) === filename) {
    return sourcePath;
  }

  const uploadPath = path.join(
    outputPath,
    "upload-artifacts",
    "content-addressed",
    filename,
  );
  await fs.promises.mkdir(path.dirname(uploadPath), { recursive: true });
  await fs.promises.copyFile(sourcePath, uploadPath);
  return uploadPath;
};

export const prepareContentAddressedAssetUploadTargets = async ({
  manifest,
  outputPath,
  targetFiles,
}: {
  manifest: Manifest;
  outputPath: string;
  targetFiles: ManifestTargetFile[];
}) => {
  const candidates = new Map<
    string,
    {
      targetFile: ManifestTargetFile;
      targetNames: string[];
    }
  >();

  for (const targetFile of targetFiles) {
    const manifestAsset = manifest.assets[targetFile.name];
    if (!manifestAsset?.fileHash) {
      throw new Error(`Manifest file hash not found for ${targetFile.name}`);
    }

    const downloadPath = getManifestAssetDownloadPath(targetFile.name);
    const logicalStoragePath = getManifestAssetStoragePath({
      assetPath: downloadPath,
      fileHash: manifestAsset.fileHash,
    });
    const candidateKey = `${downloadPath === targetFile.name ? "raw" : "br"}:${logicalStoragePath}`;

    const candidate = candidates.get(candidateKey);
    if (candidate) {
      candidate.targetNames.push(targetFile.name);
    } else {
      candidates.set(candidateKey, {
        targetFile,
        targetNames: [targetFile.name],
      });
    }
  }

  const targets = new Map<string, PreparedAssetUploadTarget>();
  await runWithConcurrency(
    [...candidates.values()],
    MANIFEST_ASSET_UPLOAD_CONCURRENCY,
    async ({ targetFile, targetNames }) => {
      const uploadName = getManifestAssetDownloadPath(targetFile.name);
      const usesBrotli = uploadName !== targetFile.name;
      const preparedPath = await prepareManifestAssetUploadFile({
        outputPath,
        targetFile,
      });
      const downloadByteSize = await getStorageFileByteSize(preparedPath);
      const downloadFileHash = usesBrotli
        ? await getFileHashFromFile(preparedPath)
        : undefined;
      if (
        downloadFileHash !== undefined &&
        !isContentAddressedAssetFileHash(downloadFileHash)
      ) {
        throw new Error(
          `Prepared asset hash must be a lowercase SHA-256 hash: ${targetFile.name}`,
        );
      }

      const manifestAsset = manifest.assets[targetFile.name]!;
      const storagePath = getManifestAssetStoragePath({
        assetPath: uploadName,
        downloadFileHash,
        fileHash: manifestAsset.fileHash,
      });
      const uploadSourcePath = await prepareContentAddressedUploadFile({
        outputPath,
        sourcePath: preparedPath,
        storagePath,
      });

      for (const targetName of targetNames) {
        manifest.assets[targetName] = {
          ...manifest.assets[targetName]!,
          downloadByteSize,
          ...(downloadFileHash ? { downloadFileHash } : {}),
        };
      }
      targets.set(storagePath, { storagePath, uploadSourcePath });
    },
  );

  return [...targets.values()].sort((left, right) =>
    left.storagePath.localeCompare(right.storagePath),
  );
};

/**
 * Uploads one content-addressed asset under the shared `assets` root, unless
 * storage already holds it. Returns whether it uploaded.
 */
export const uploadContentAddressedAsset = async (
  storageAdapter: StorageAdapterWith<"put" | "exists">,
  assetBaseStorageUri: string,
  { storagePath, uploadSourcePath }: PreparedAssetUploadTarget,
): Promise<boolean> => {
  const storageUri = createStorageUriWithRelativePath({
    baseStorageUri: assetBaseStorageUri,
    relativePath: storagePath,
  });
  if ((await storageAdapter.exists({ storageUri })).exists) return false;
  const uploadKey = ["assets", getRelativeStorageDir(storagePath)]
    .filter(Boolean)
    .join("/");
  await putStorageFile(storageAdapter, uploadKey, uploadSourcePath);
  return true;
};
