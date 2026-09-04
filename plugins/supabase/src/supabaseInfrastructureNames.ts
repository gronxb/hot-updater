export const SUPABASE_V1_FUNCTION_NAME = "hot-updater-v1";

export const SUPABASE_V1_TABLE_NAMES = {
  apiKeys: "hot_updater_v1_api_keys",
  bundleEvents: "hot_updater_v1_bundle_events",
  bundlePatches: "hot_updater_v1_bundle_patches",
  bundles: "hot_updater_v1_bundles",
  channels: "hot_updater_v1_channels",
  releaseCatalogs: "hot_updater_v1_release_catalogs",
  releases: "hot_updater_v1_releases",
  settings: "hot_updater_v1_private_settings",
} as const;

export const SUPABASE_V1_FUNCTION_NAMES = {
  commit: "hot_updater_v1_commit",
  deleteChannel: "hot_updater_v1_delete_channel",
} as const;
