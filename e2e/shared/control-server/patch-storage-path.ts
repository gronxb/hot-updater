export function inferPatchAssetPathFromStorageUri({
  baseBundleId,
  patchFileHash,
  patchStorageUri,
}: {
  baseBundleId: string;
  patchFileHash: string;
  patchStorageUri: string;
}) {
  let pathname: string;
  try {
    pathname = new URL(patchStorageUri).pathname;
  } catch {
    return null;
  }

  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const patchesIndex = segments.findIndex(
    (segment, index) =>
      segment === "patches" && segments[index + 1] === baseBundleId,
  );
  if (patchesIndex === -1) {
    return null;
  }

  const patchSegments = segments.slice(patchesIndex + 2);
  if (patchSegments[0] === patchFileHash) {
    patchSegments.shift();
  }
  const patchPath = patchSegments.join("/");
  return patchPath.endsWith(".bsdiff")
    ? patchPath.slice(0, -".bsdiff".length)
    : null;
}
