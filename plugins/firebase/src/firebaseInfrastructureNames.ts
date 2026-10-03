export const FIREBASE_V1_FUNCTION_NAME = "hot-updater-v1";

/**
 * The one collection the storage engine keeps every item in. It namespaces
 * the data, so item partitions are table names with no prefix.
 */
export const FIREBASE_V1_COLLECTION = "hot_updater_v1";

/**
 * The collections a 1.0 release candidate wrote before the storage engine.
 * Init reads them only to refuse such a database.
 */
export const FIREBASE_PRE_ENGINE_COLLECTIONS = [
  "hot_updater_v1_private_settings",
  "hot_updater_v1_bundles",
  "hot_updater_v1_bundle_patches",
  "hot_updater_v1_channels",
  "hot_updater_v1_release_catalogs",
] as const;
