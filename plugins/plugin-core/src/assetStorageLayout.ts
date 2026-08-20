import { getContentAddressedAssetStoragePath } from "./contentAddressedAssets";
import { createStorageKeyBuilder } from "./createStorageKeyBuilder";
import { createStorageUri, parseStorageUri } from "./parseStorageUri";

export const isBrotliManifestAssetPath = (assetPath: string) =>
  /(^|\/)index\.[^/]+\.bundle$/.test(assetPath.replace(/\\/g, "/"));

export const getManifestAssetDownloadPath = (assetPath: string) =>
  isBrotliManifestAssetPath(assetPath) ? `${assetPath}.br` : assetPath;

export const createStorageUriWithRelativePath = ({
  baseStorageUri,
  relativePath,
}: {
  baseStorageUri: string;
  relativePath: string;
}) => {
  const protocol = new URL(baseStorageUri).protocol.replace(":", "");
  const parsed = parseStorageUri(baseStorageUri, protocol);
  const childKey = createStorageKeyBuilder(undefined)(relativePath);
  if (!childKey) {
    throw new Error("Relative storage key must not be empty.");
  }
  return createStorageUri({
    protocol: parsed.protocol,
    bucket: parsed.bucket,
    key: createStorageKeyBuilder(parsed.key)(childKey),
  });
};

export const replaceStorageUriKeySuffix = ({
  storageUri,
  keySuffix,
  replacement,
}: {
  storageUri: string;
  keySuffix: string;
  replacement: string;
}) => {
  const protocol = new URL(storageUri).protocol.replace(":", "");
  const parsed = parseStorageUri(storageUri, protocol);
  const normalizedSuffix = createStorageKeyBuilder(undefined)(keySuffix);
  const normalizedReplacement = createStorageKeyBuilder(undefined)(replacement);
  if (!normalizedSuffix || !normalizedReplacement) {
    throw new Error(
      "Storage URI key suffix and replacement must not be empty.",
    );
  }
  const keySegments = parsed.key.split("/");
  const suffixSegments = normalizedSuffix.split("/");
  const suffixOffset = keySegments.length - suffixSegments.length;
  if (
    suffixOffset < 0 ||
    suffixSegments.some(
      (segment, index) => keySegments[suffixOffset + index] !== segment,
    )
  ) {
    throw new Error("Storage URI key does not end with the expected suffix.");
  }
  const prefix = keySegments.slice(0, suffixOffset).join("/");
  return createStorageUri({
    protocol: parsed.protocol,
    bucket: parsed.bucket,
    key: createStorageKeyBuilder(prefix)(normalizedReplacement),
  });
};

export const getManifestAssetStoragePath = ({
  assetPath,
  fileHash,
}: {
  assetPath: string;
  fileHash: string;
}) =>
  getContentAddressedAssetStoragePath({
    assetPath,
    fileHash,
  });

export const resolveManifestAssetStorageUri = ({
  assetBaseStorageUri,
  assetPath,
  fileHash,
}: {
  assetBaseStorageUri: string;
  assetPath: string;
  fileHash: string;
}) =>
  createStorageUriWithRelativePath({
    baseStorageUri: assetBaseStorageUri,
    relativePath: getManifestAssetStoragePath({
      assetPath,
      fileHash,
    }),
  });
