export const BUNDLE_STORAGE_PREFIX = "bundles";

export const createBundleStorageKey = (
  bundleId: string,
  ...relativePaths: string[]
) =>
  [BUNDLE_STORAGE_PREFIX, bundleId, ...relativePaths].filter(Boolean).join("/");

export const createStorageRootUriWithPath = (
  storageUri: string,
  bundleId: string,
  relativePath: string,
) => {
  const storageUrl = new URL(storageUri);
  const segments = storageUrl.pathname.split("/").filter(Boolean);
  const bundleIndex = segments.lastIndexOf(bundleId);
  if (bundleIndex < 1 || segments[bundleIndex - 1] !== BUNDLE_STORAGE_PREFIX) {
    throw new Error(
      `Storage URI does not contain canonical bundle path: ${BUNDLE_STORAGE_PREFIX}/${bundleId}`,
    );
  }
  const rootSegments = segments.slice(0, bundleIndex - 1);

  const relativeSegments = relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  storageUrl.pathname = `/${[...rootSegments, ...relativeSegments].join("/")}`;
  return storageUrl.toString();
};
