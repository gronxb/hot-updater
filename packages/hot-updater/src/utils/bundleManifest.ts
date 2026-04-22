import fs from "fs/promises";
import path from "path";

import { getFileHashFromFile } from "./getFileHash";

export interface Manifest {
  bundleId: string;
  assets: Record<string, ManifestAsset>;
}

export interface ManifestAsset {
  fileHash: string;
  signature?: string;
}

export const createBundleManifest = async ({
  bundleId,
  signFileHash,
  targetFiles,
}: {
  bundleId: string;
  signFileHash?: (fileHash: string) => Promise<string>;
  targetFiles: { path: string; name: string }[];
}): Promise<Manifest> => {
  const assets = Object.fromEntries(
    await Promise.all(
      [...targetFiles]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (target) => {
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
        }),
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
  signFileHash,
  targetFiles,
}: {
  buildPath: string;
  bundleId: string;
  signFileHash?: (fileHash: string) => Promise<string>;
  targetFiles: { path: string; name: string }[];
}) => {
  const manifest = await createBundleManifest({
    bundleId,
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
