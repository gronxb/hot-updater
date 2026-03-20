import fs from "fs/promises";
import { getFileHashFromFile } from "./getFileHash";

export const BUNDLE_MANIFEST_FILENAME = "manifest.json";

export interface BundleManifestTargetFile {
  path: string;
  name: string;
}

export interface BundleManifest {
  bundleId: string;
  files: Record<string, string>;
}

export const createBundleManifest = async (
  bundleId: string,
  targetFiles: BundleManifestTargetFile[],
): Promise<BundleManifest> => {
  const fileEntries = await Promise.all(
    targetFiles.map(async (target) => {
      const fileHash = await getFileHashFromFile(target.path);
      return [target.name, fileHash] as const;
    }),
  );

  fileEntries.sort(([left], [right]) => left.localeCompare(right));

  return {
    bundleId,
    files: Object.fromEntries(fileEntries),
  };
};

export const writeBundleManifestFile = async (
  manifestPath: string,
  manifest: BundleManifest,
) => {
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};
