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
  if (bundleIndex < 0) {
    throw new Error(`Storage URI does not contain bundle id: ${bundleId}`);
  }
  const rootSegments = segments.slice(0, bundleIndex);
  if (rootSegments.at(-1) === BUNDLE_STORAGE_PREFIX) {
    rootSegments.pop();
  }

  const relativeSegments = relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  storageUrl.pathname = `/${[...rootSegments, ...relativeSegments].join("/")}`;
  return storageUrl.toString();
};
