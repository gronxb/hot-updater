import type { Bundle } from "@hot-updater/core";

export type SupabaseBundleRow = {
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
};

export type SupabaseBundlePatchRow = {
  id: string;
  bundle_id: string;
  base_bundle_id: string;
  base_file_hash: string;
  patch_file_hash: string;
  patch_storage_uri: string;
  order_index: number;
};

export type SupabaseTelemetryKeyRow = {
  id: string;
  key_hash: string;
  key_suffix: string;
  updated_at: string;
};

export type SupabaseBundleLifecycleEventRow = {
  bundle_id: string;
  channel: string;
  crashed_bundle_id: string | null;
  event_id: string;
  install_id: string;
  observed_at: string;
  platform: Bundle["platform"];
  received_at: string;
  status: "ACTIVE" | "RECOVERED";
};

export type SupabaseBundleLifecycleMetricRow = {
  active_count: number;
  bucket_start: string;
  bundle_id: string;
  channel: string;
  last_seen_at: string;
  platform: Bundle["platform"];
  recovered_count: number;
};

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
      telemetry_keys: {
        Row: SupabaseTelemetryKeyRow;
        Insert: SupabaseTelemetryKeyRow;
        Update: SupabaseTelemetryKeyRow;
        Relationships: [];
      };
      bundle_lifecycle_events: {
        Row: SupabaseBundleLifecycleEventRow;
        Insert: SupabaseBundleLifecycleEventRow;
        Update: SupabaseBundleLifecycleEventRow;
        Relationships: [];
      };
      bundle_lifecycle_metrics: {
        Row: SupabaseBundleLifecycleMetricRow;
        Insert: SupabaseBundleLifecycleMetricRow;
        Update: SupabaseBundleLifecycleMetricRow;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Enums: {
      platforms: Bundle["platform"];
    };
    Functions: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
