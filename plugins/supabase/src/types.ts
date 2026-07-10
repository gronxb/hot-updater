import type { Bundle } from "@hot-updater/core";

export interface SupabaseBundleRow {
  id: string;
  channel: string;
  enabled: boolean;
  should_force_update: boolean;
  file_hash: string;
  git_commit_hash: string | null;
  message: string | null;
  platform: Bundle["platform"];
  target_app_version: string | null;
  fingerprint_hash: string | null;
  storage_uri: string;
  metadata: Bundle["metadata"] | null;
  manifest_storage_uri: string | null;
  manifest_file_hash: string | null;
  asset_base_storage_uri: string | null;
  rollout_cohort_count: number | null;
  target_cohorts: string[] | null;
}

export interface SupabaseBundlePatchRow {
  id: string;
  bundle_id: string;
  base_bundle_id: string;
  base_file_hash: string;
  patch_file_hash: string;
  patch_storage_uri: string;
  order_index: number;
}

export interface SupabaseBundleEventRow {
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

export type Database = {
  public: {
    Tables: {
      bundles: {
        Row: SupabaseBundleRow;
        Insert: SupabaseBundleRow;
        Update: SupabaseBundleRow;
        Relationships: [];
      };
      bundle_patches: {
        Row: SupabaseBundlePatchRow;
        Insert: SupabaseBundlePatchRow;
        Update: SupabaseBundlePatchRow;
        Relationships: [];
      };
      bundle_events: {
        Row: SupabaseBundleEventRow;
        Insert: SupabaseBundleEventRow;
        Update: SupabaseBundleEventRow;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
  };
};
