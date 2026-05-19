export const getContentAddressedAssetStoragePath = ({
  assetPath,
  fileHash,
}: {
  assetPath: string;
  fileHash: string;
}) => {
  // Shared asset storage is a plugin/server contract, not a React Native
  // runtime API. The extension is derived from the logical download path so
  // Hermes bundles keep their .br object while images/fonts keep theirs.
  const extension = assetPath.endsWith(".br")
    ? ".br"
    : assetPath.includes(".")
      ? `.${assetPath.split(".").pop()!}`
      : "";
  return `sha256/${fileHash.slice(0, 2)}/${fileHash}${extension}`;
};
