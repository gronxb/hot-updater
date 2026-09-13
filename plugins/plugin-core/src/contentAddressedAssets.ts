export const CONTENT_ADDRESSED_ASSET_PREFIX = "assets";

const SHA256_FILE_HASH_RE = /^[0-9a-f]{64}$/;

export const isContentAddressedAssetFileHash = (
  value: unknown,
): value is string => {
  return typeof value === "string" && SHA256_FILE_HASH_RE.test(value);
};

export const getContentAddressedAssetStoragePath = ({
  assetPath,
  fileHash,
}: {
  assetPath: string;
  fileHash: string;
}) => {
  // The extension comes from the logical download path. Compressed artifacts
  // keep .br, while opaque artifacts keep their declared extension.
  const extension = assetPath.endsWith(".br")
    ? ".br"
    : assetPath.includes(".")
      ? `.${assetPath.split(".").pop()!}`
      : "";
  return `sha256/${fileHash.slice(0, 2)}/${fileHash}${extension}`;
};
