import path from "node:path";

import {
  findPortableArtifactPathConflict,
  getBundleArchiveEntryCount,
  getUtf8ByteSize,
  MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES,
  MAX_BUNDLE_ARCHIVE_ENTRIES,
} from "@hot-updater/plugin-core";

const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

export const isCanonicalManifestAssetPath = (assetPath: string) =>
  assetPath.length > 0 &&
  !assetPath.includes("\\") &&
  !assetPath.includes(":") &&
  !path.posix.isAbsolute(assetPath) &&
  !hasControlCharacter(assetPath) &&
  getUtf8ByteSize(assetPath) <= MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES &&
  assetPath
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );

export const hasCanonicalManifestAssetPaths = ({
  assetPaths,
  patchAssetPath,
}: {
  assetPaths: readonly string[];
  patchAssetPath?: string;
}) => {
  if (
    getBundleArchiveEntryCount(assetPaths) > MAX_BUNDLE_ARCHIVE_ENTRIES ||
    assetPaths.some((assetPath) => !isCanonicalManifestAssetPath(assetPath)) ||
    findPortableArtifactPathConflict([...assetPaths, "manifest.json"])
  ) {
    return false;
  }

  return (
    patchAssetPath === undefined ||
    (isCanonicalManifestAssetPath(patchAssetPath) &&
      assetPaths.includes(patchAssetPath))
  );
};
