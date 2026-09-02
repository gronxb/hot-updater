export const SUPABASE_V1_FUNCTION_NAME = "hot-updater-v1";

export const SUPABASE_V1_TABLE_NAMES = {
  apiKeys: "hot_updater_v1_api_keys",
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
  insightsPrepareRead: "hot_updater_v1_insights_prepare_read",
  insightsPrepare: "hot_updater_v1_insights_prepare",
  insightsAppend: "hot_updater_v1_insights_append",
  insightsEventPage: "hot_updater_v1_insights_event_page",
  insightsInstallationPage: "hot_updater_v1_insights_installation_page",
  insightsSearchStep: "hot_updater_v1_insights_search_step",
  insightsReport: "hot_updater_v1_insights_report",
  insightsReportStep: "hot_updater_v1_insights_report_step",
  insightsReportPage: "hot_updater_v1_insights_report_page",
  insightsPrune: "hot_updater_v1_insights_prune",
  insightsJobNext: "hot_updater_v1_insights_job_next",
} as const;
