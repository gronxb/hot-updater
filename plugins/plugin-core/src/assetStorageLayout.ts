import { getContentAddressedAssetStoragePath } from "./contentAddressedAssets";
import { getLegacyManifestAssetStoragePath } from "./legacyAssetStorageLayout";

export type AssetStorageLayout = "content-addressed" | "legacy-files";

export const createStorageUriWithRelativePath = ({
  baseStorageUri,
  relativePath,
}: {
  baseStorageUri: string;
  relativePath: string;
}) => {
  const storageUrl = new URL(baseStorageUri);
  const normalizedBasePath = storageUrl.pathname.replace(/\/+$/, "");
  const normalizedRelativePath = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  storageUrl.pathname = `${normalizedBasePath}/${normalizedRelativePath}`;
  return storageUrl.toString();
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
