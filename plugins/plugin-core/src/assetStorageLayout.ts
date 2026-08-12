import { getContentAddressedAssetStoragePath } from "./contentAddressedAssets";
import { createStorageKeyBuilder } from "./createStorageKeyBuilder";
import { getLegacyManifestAssetStoragePath } from "./legacyAssetStorageLayout";
import { createStorageUri, parseStorageUri } from "./parseStorageUri";

export type AssetStorageLayout = "content-addressed" | "legacy-files";

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

export const getAssetStorageLayout = (
  assetBaseStorageUri: string,
): AssetStorageLayout => {
  const pathname = new URL(assetBaseStorageUri).pathname.replace(/\/+$/, "");
  return pathname.endsWith("/assets") || pathname === "/assets"
    ? "content-addressed"
    : "legacy-files";
};

export const isContentAddressedAssetBaseStorageUri = (
  assetBaseStorageUri: string,
) => getAssetStorageLayout(assetBaseStorageUri) === "content-addressed";

export const getManifestAssetStoragePath = ({
  assetBaseStorageUri,
  assetPath,
  fileHash,
}: {
  assetBaseStorageUri: string;
  assetPath: string;
  fileHash: string;
}) => {
  const layout = getAssetStorageLayout(assetBaseStorageUri);

  if (layout === "content-addressed") {
    return getContentAddressedAssetStoragePath({
      assetPath,
      fileHash,
    });
  }

  return getLegacyManifestAssetStoragePath({ assetPath });
};

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
      assetBaseStorageUri,
      assetPath,
      fileHash,
    }),
  });
