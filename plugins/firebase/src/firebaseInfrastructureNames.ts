export const FIREBASE_V1_FUNCTION_NAME = "hot-updater-v1";
export const FIREBASE_LEGACY_INSTALLATIONS_COLLECTION =
  "hot_updater_v1_bundle_installations";

export const FIREBASE_V1_COLLECTION_NAMES = {
  apiKeys: "hot_updater_v1_api_keys",
  bundleEvents: "hot_updater_v1_bundle_events",
  bundleInstallations: "hot_updater_v1_insights_installations",
  bundlePatches: "hot_updater_v1_bundle_patches",
  bundles: "hot_updater_v1_bundles",
  channels: "hot_updater_v1_channels",
  releaseCatalogs: "hot_updater_v1_release_catalogs",
  releases: "hot_updater_v1_releases",
  settings: "hot_updater_v1_private_settings",
} as const;
