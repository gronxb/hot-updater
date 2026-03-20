import fs from "fs/promises";
import path from "path";
import { getFileHashFromFile } from "./getFileHash";

export interface BundleManifest {
  bundleId: string;
  assets: Record<string, string>;
}

export const createBundleManifest = async ({
  bundleId,
  targetFiles,
}: {
  bundleId: string;
  targetFiles: { path: string; name: string }[];
}): Promise<BundleManifest> => {
  const assets = Object.fromEntries(
    await Promise.all(
      [...targetFiles]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(
          async (target) =>
            [target.name, await getFileHashFromFile(target.path)] as const,
        ),
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
  targetFiles,
}: {
  buildPath: string;
  bundleId: string;
  targetFiles: { path: string; name: string }[];
}) => {
  const manifest = await createBundleManifest({ bundleId, targetFiles });
  const manifestPath = path.join(buildPath, "manifest.json");

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    manifestPath,
  };
};
