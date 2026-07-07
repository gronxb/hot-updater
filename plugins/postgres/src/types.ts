import type { Bundle } from "@hot-updater/core";

export interface PostgresBundleRow {
  id: string;
  channel: string;
  enabled: boolean;
  should_force_update: boolean;
  file_hash: string;
  git_commit_hash: string | null;
  message: string | null;
  platform: Bundle["platform"];
  target_app_version: string | null;
  storage_uri: string;
  fingerprint_hash: string | null;
  metadata: Bundle["metadata"] | null;
  manifest_storage_uri: string | null;
  manifest_file_hash: string | null;
  asset_base_storage_uri: string | null;
  rollout_cohort_count: number | null;
  target_cohorts: string[] | null;
}

export interface PostgresBundlePatchRow {
  id: string;
  bundle_id: string;
  base_bundle_id: string;
  base_file_hash: string;
  patch_file_hash: string;
  patch_storage_uri: string;
  order_index: number;
}

export interface PostgresBundleEventRow {
  id: string;
  kind: string;
  install_id: string;
  active_bundle_id: string;
  previous_active_bundle_id: string | null;
  crashed_bundle_id: string | null;
  platform: Bundle["platform"];
  channel: string;
  app_version: string | null;
  fingerprint_hash: string | null;
  cohort: string | null;
  user_id: string | null;
  payload: unknown;
}

export interface Database {
  bundles: PostgresBundleRow;
  bundle_patches: PostgresBundlePatchRow;
  bundle_events: PostgresBundleEventRow;
}
