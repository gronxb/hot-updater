import fs from "fs/promises";
import path from "path";

import { createSignedFileHash } from "@/signedHashUtils";

import { getFileHashFromFile } from "./getFileHash";
import { signBundle } from "./signing/bundleSigning";

export interface Manifest {
  bundleId: string;
  assets: Record<string, ManifestAsset>;
}

export interface ManifestAsset {
  fileHash: string;
}

export const createBundleManifest = async ({
  bundleId,
  signingPrivateKeyPath,
  targetFiles,
}: {
  bundleId: string;
  signingPrivateKeyPath?: string;
  targetFiles: { path: string; name: string }[];
}): Promise<Manifest> => {
  const assets = Object.fromEntries(
    await Promise.all(
      [...targetFiles]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (target) => {
          const fileHash = await getFileHashFromFile(target.path);
          const signedFileHash = signingPrivateKeyPath
            ? createSignedFileHash(
                await signBundle(fileHash, signingPrivateKeyPath),
              )
            : fileHash;

          return [
            target.name,
            {
              fileHash: signedFileHash,
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
  signingPrivateKeyPath,
  targetFiles,
}: {
  buildPath: string;
  bundleId: string;
  signingPrivateKeyPath?: string;
  targetFiles: { path: string; name: string }[];
}) => {
  const manifest = await createBundleManifest({
    bundleId,
    signingPrivateKeyPath,
    targetFiles,
  });
  const manifestPath = path.join(buildPath, "manifest.json");

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    manifestPath,
  };
};
