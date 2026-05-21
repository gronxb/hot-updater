import fs from "fs/promises";
import path from "path";

import { getFileHashFromFile } from "./getFileHash";

const MANIFEST_HASH_CONCURRENCY = 8;

export interface Manifest {
  bundleId: string;
  assets: Record<string, ManifestAsset>;
}

export interface ManifestAsset {
  fileHash: string;
  signature?: string;
}

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
  signFileHash,
  targetFiles,
}: {
  bundleId: string;
  hashConcurrency?: number;
  signFileHash?: (fileHash: string) => Promise<string>;
  targetFiles: { path: string; name: string }[];
}): Promise<Manifest> => {
  if (!Number.isInteger(hashConcurrency) || hashConcurrency < 1) {
    throw new Error("Manifest hash concurrency must be a positive integer");
  }

  const assets = Object.fromEntries(
    await mapWithConcurrency(
      [...targetFiles].sort((left, right) =>
        left.name.localeCompare(right.name),
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
            fileHash,
            ...(signature ? { signature } : {}),
          },
        ] as const;
      },
    ),
  );

  return {
    bundleId,
    assets,
  };
};

export const writeBundleManifest = async ({
  buildPath,
  bundleId,
  hashConcurrency,
  signFileHash,
  targetFiles,
}: {
  buildPath: string;
  bundleId: string;
  hashConcurrency?: number;
  signFileHash?: (fileHash: string) => Promise<string>;
  targetFiles: { path: string; name: string }[];
}) => {
  const manifest = await createBundleManifest({
    bundleId,
    hashConcurrency,
    signFileHash,
    targetFiles,
  });
  const manifestPath = path.join(buildPath, "manifest.json");

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    manifestPath,
  };
};
