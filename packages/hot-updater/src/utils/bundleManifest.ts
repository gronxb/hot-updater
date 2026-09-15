import fs from "fs/promises";
import path from "path";

import type { BundleManifest } from "@hot-updater/core";
import {
  assertBundleManifestByteSize,
  type BuildArtifact,
  compareStringsByCodeUnit,
} from "@hot-updater/plugin-core";

import { getFileHashFromFile } from "./getFileHash";

const MANIFEST_HASH_CONCURRENCY = 8;

export type Manifest = BundleManifest;

export const serializeBundleManifest = (manifest: Manifest): string => {
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  assertBundleManifestByteSize(Buffer.byteLength(contents));
  return contents;
};

export const writeBundleManifestFile = async ({
  buildPath,
  manifest,
}: {
  buildPath: string;
  manifest: Manifest;
}) => {
  const manifestPath = path.join(buildPath, "manifest.json");

  await fs.writeFile(manifestPath, serializeBundleManifest(manifest));

  return manifestPath;
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
) => {
  let nextIndex = 0;
  const results: R[] = [];
  results.length = items.length;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const itemIndex = nextIndex;
        nextIndex += 1;
        results[itemIndex] = await task(items[itemIndex]!);
      }
    }),
  );

  return results;
};

export const createBundleManifest = async ({
  bundleId,
  hashConcurrency = MANIFEST_HASH_CONCURRENCY,
  patchAssetPath,
  signFileHash,
  targetFiles,
}: {
  bundleId: string;
  hashConcurrency?: number;
  patchAssetPath: string;
  signFileHash?: (fileHash: string) => Promise<string>;
  targetFiles: BuildArtifact[];
}): Promise<Manifest> => {
  if (!Number.isInteger(hashConcurrency) || hashConcurrency < 1) {
    throw new Error("Manifest hash concurrency must be a positive integer");
  }
  if (!targetFiles.some((target) => target.name === patchAssetPath)) {
    throw new Error("patchAssetPath must name a declared build artifact");
  }

  const assets = Object.fromEntries(
    await mapWithConcurrency(
      [...targetFiles].sort((left, right) =>
        compareStringsByCodeUnit(left.name, right.name),
      ),
      hashConcurrency,
      async (target) => {
        const fileHash = await getFileHashFromFile(target.path);
        const signature = signFileHash
          ? await signFileHash(fileHash)
          : undefined;

        return [
          target.name,
          {
            downloadCompression: target.downloadCompression,
            fileHash,
            ...(signature ? { signature } : {}),
          },
        ] as const;
      },
    ),
  );

  return {
    assets,
    bundleId,
    patchAssetPath,
  };
};

export const writeBundleManifest = async ({
  buildPath,
  bundleId,
  hashConcurrency,
  patchAssetPath,
  signFileHash,
  targetFiles,
}: {
  buildPath: string;
  bundleId: string;
  hashConcurrency?: number;
  patchAssetPath: string;
  signFileHash?: (fileHash: string) => Promise<string>;
  targetFiles: BuildArtifact[];
}) => {
  const manifest = await createBundleManifest({
    bundleId,
    hashConcurrency,
    patchAssetPath,
    signFileHash,
    targetFiles,
  });
  const manifestPath = await writeBundleManifestFile({ buildPath, manifest });

  return {
    manifest,
    manifestPath,
  };
};
