/**
 * @internal
 *
 * Legacy manifest assets were stored below each bundle's `/files` directory
 * using their manifest-relative path. Keep all old-layout path decisions here
 * so support can be removed by deleting this module and the entrypoint branch
 * that imports it.
 */
export const getLegacyManifestAssetStoragePath = ({
  assetPath,
}: {
  assetPath: string;
}) => assetPath;
