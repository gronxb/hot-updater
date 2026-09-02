export const FIREBASE_V1_FUNCTION_NAME = "hot-updater-v1";
export const FIREBASE_INSIGHTS_DATABASE_NAMESPACE_ENV =
  "HOT_UPDATER_FIREBASE_INSIGHTS_DATABASE_NAMESPACE";

export const FIREBASE_V1_COLLECTION_NAMES = {
  apiKeys: "hot_updater_v1_api_keys",
  bundleEvents: "hot_updater_v1_bundle_events",
  bundlePatches: "hot_updater_v1_bundle_patches",
  bundles: "hot_updater_v1_bundles",
  channels: "hot_updater_v1_channels",
  releaseCatalogs: "hot_updater_v1_release_catalogs",
  releases: "hot_updater_v1_releases",
  settings: "hot_updater_v1_private_settings",
} as const;

export const FIREBASE_V2_INSIGHTS_COLLECTION_NAMES = {
  control: "hot_updater_v2_private_insights",
  events: "hot_updater_v2_insights_events",
  heads: "hot_updater_v2_insights_query_heads",
  installations: "hot_updater_v2_insights_installations",
  installationVersions: "hot_updater_v2_insights_installation_versions",
  jobs: "hot_updater_v2_insights_jobs",
  poison: "hot_updater_v2_insights_poison",
  publications: "hot_updater_v2_insights_publications",
  reportCounts: "hot_updater_v2_insights_report_counts",
  reportRows: "hot_updater_v2_insights_report_rows",
  sourceClocks: "hot_updater_v2_insights_source_clocks",
  work: "hot_updater_v2_insights_work",
} as const;
