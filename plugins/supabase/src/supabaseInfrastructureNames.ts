export const SUPABASE_V1_FUNCTION_NAME = "hot-updater-v1";

export const SUPABASE_V1_TABLE_NAMES = {
  apiKeys: "hot_updater_v1_api_keys",
  bundleEvents: "hot_updater_v1_bundle_events",
  bundleEventHeads: "hot_updater_v1_bundle_event_heads",
  insightsInstallStates: "hot_updater_v1_insights_install_states",
  insightsLifetimeMarkers: "hot_updater_v1_insights_lifetime_markers",
  insightsReleaseSummaries: "hot_updater_v1_insights_release_summaries",
  insightsHourlyActivity: "hot_updater_v1_insights_hourly_activity",
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
  recordEvent: "hot_updater_v1_record_event",
  recordPreparedEvent: "hot_updater_v1_record_prepared_event",
  getReleaseActivity: "hot_updater_v1_get_release_activity",
} as const;
