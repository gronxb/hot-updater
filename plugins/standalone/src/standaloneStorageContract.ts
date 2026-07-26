export const STANDALONE_STORAGE_V2 = Object.freeze({
  routes: Object.freeze({
    object: "/hot-updater/storage/v2/objects",
    delivery: "/hot-updater/storage/v2/delivery",
  }),
  headers: Object.freeze({
    contentLength: "x-hot-updater-storage-content-length",
    expiresAt: "x-hot-updater-storage-expires-at",
    expiresInSeconds: "x-hot-updater-storage-expires-in-seconds",
    key: "x-hot-updater-storage-key",
    metadata: "x-hot-updater-storage-metadata",
    storageUri: "x-hot-updater-storage-uri",
  }),
} as const);

export type StandaloneStorageV2RouteName =
  keyof typeof STANDALONE_STORAGE_V2.routes;

export const encodeStandaloneStorageHeader = (value: string): string =>
  encodeURIComponent(value);

export const decodeStandaloneStorageHeader = (
  headers: Headers,
  name: string,
): string | undefined => {
  const value = headers.get(name);
  if (value === null) return undefined;
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
};
