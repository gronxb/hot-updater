import type {
  BundlePatchRow,
  BundleRow,
  BundleEventRow,
  ChannelRow,
  ChannelDeleteResult,
  ApiKeyRow,
  DatabaseCommit,
  DatabaseCommitResult,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import type { PreparedInsightsEvent } from "@hot-updater/plugin-core/internal";

import {
  SUPABASE_V1_FUNCTION_NAMES,
  SUPABASE_V1_TABLE_NAMES,
} from "./supabaseInfrastructureNames";

export type SupabaseBundleRow = {
  [TField in keyof BundleRow]: BundleRow[TField];
};

export type SupabaseBundlePatchRow = {
  [TField in keyof BundlePatchRow]: BundlePatchRow[TField];
};

export type SupabaseBundleEventRow = BundleEventRow;

export type SupabaseApiKeyRow = {
  [TField in keyof ApiKeyRow]: ApiKeyRow[TField];
};

export type SupabaseChannelRow = {
  [TField in keyof ChannelRow]: ChannelRow[TField];
};

export type SupabaseReleaseRow = {
  [TField in keyof ReleaseRow]: ReleaseRow[TField];
};

export type SupabaseReleaseCatalogRow = {
  [TField in keyof ReleaseCatalogRow]: ReleaseCatalogRow[TField];
};

type Table<TRow> = {
  Row: TRow;
  Insert: TRow;
  Update: Partial<TRow>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      [SUPABASE_V1_TABLE_NAMES.bundles]: Table<SupabaseBundleRow>;
      [SUPABASE_V1_TABLE_NAMES.bundlePatches]: Table<SupabaseBundlePatchRow>;
      [SUPABASE_V1_TABLE_NAMES.channels]: Table<SupabaseChannelRow>;
      [SUPABASE_V1_TABLE_NAMES.bundleEvents]: Table<SupabaseBundleEventRow>;
      [SUPABASE_V1_TABLE_NAMES.bundleEventHeads]: Table<
        Pick<
          BundleEventRow,
          | "install_id"
          | "id"
          | "received_at_ms"
          | "user_id"
          | "platform"
          | "channel"
          | "type"
          | "from_bundle_id"
          | "to_bundle_id"
        >
      >;
      [SUPABASE_V1_TABLE_NAMES.insightsInstallStates]: Table<{
        install_id: string;
        revision: number;
        state: string;
      }>;
      [SUPABASE_V1_TABLE_NAMES.insightsLifetimeMarkers]: Table<{
        marker_key: string;
        release_key: string;
        install_id: string;
        metric: "downloaded" | "recovered";
      }>;
      [SUPABASE_V1_TABLE_NAMES.insightsReleaseSummaries]: Table<{
        release_key: string;
        platform: "ios" | "android";
        channel: string;
        release_id: string;
        active_installations: number;
        pending_installations: number;
        downloaded_installations: number;
        recovered_installations: number;
      }>;
      [SUPABASE_V1_TABLE_NAMES.insightsHourlyActivity]: Table<{
        bucket_key: string;
        release_key: string;
        platform: "ios" | "android";
        channel: string;
        release_id: string;
        hour_start_ms: number;
        downloaded_reports: number;
        applied_reports: number;
        recovered_reports: number;
      }>;
      [SUPABASE_V1_TABLE_NAMES.apiKeys]: Table<SupabaseApiKeyRow>;
      [SUPABASE_V1_TABLE_NAMES.releaseCatalogs]: Table<SupabaseReleaseCatalogRow>;
      [SUPABASE_V1_TABLE_NAMES.releases]: Table<SupabaseReleaseRow>;
    };
    Views: Record<never, never>;
    Functions: {
      [SUPABASE_V1_FUNCTION_NAMES.recordEvent]: {
        Args: { p_event: BundleEventRow };
        Returns: undefined;
      };
      [SUPABASE_V1_FUNCTION_NAMES.recordPreparedEvent]: {
        Args: { p_prepared: PreparedInsightsEvent & Record<string, unknown> };
        Returns: "committed" | "duplicate" | "conflict";
      };
      [SUPABASE_V1_FUNCTION_NAMES.getReleaseActivity]: {
        Args: {
          p_release_keys: string[];
          p_start: number | null;
          p_end: number | null;
        };
        Returns: {
          summaries: Record<string, unknown>[];
          hourly: Record<string, unknown>[];
        };
      };
      [SUPABASE_V1_FUNCTION_NAMES.commit]: {
        Args: {
          p_commit: DatabaseCommit;
        };
        Returns: DatabaseCommitResult;
      };
      [SUPABASE_V1_FUNCTION_NAMES.deleteChannel]: {
        Args: {
          p_id: string;
        };
        Returns: ChannelDeleteResult;
      };
    };
  };
};
