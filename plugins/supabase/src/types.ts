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

export type SupabaseInsightsOverviewRow = {
  readonly id: string;
  readonly scope_kind: "release" | "channel" | "usage" | "distribution";
  readonly release_kind: "all" | "specific" | "embedded";
  readonly release_id: string;
  readonly channel: string;
  readonly platform: "all" | "ios" | "android";
  readonly app_version_kind: "all" | "specific";
  readonly app_version: string;
  readonly period_kind: "lifetime" | "hour" | "latest";
  readonly bucket_start_ms: number;
  readonly downloads: number;
  readonly launches: number;
  readonly failed_launches: number;
  readonly latest_installations: number;
  readonly launch_users: string | null;
  readonly activity_users: string | null;
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
        > & {
          readonly current_release_id: string | null;
          readonly app_version: string;
        }
      >;
      [SUPABASE_V1_TABLE_NAMES.insightsOverview]: Table<SupabaseInsightsOverviewRow>;
      [SUPABASE_V1_TABLE_NAMES.apiKeys]: Table<SupabaseApiKeyRow>;
      [SUPABASE_V1_TABLE_NAMES.releaseCatalogs]: Table<SupabaseReleaseCatalogRow>;
      [SUPABASE_V1_TABLE_NAMES.releases]: Table<SupabaseReleaseRow>;
    };
    Views: Record<never, never>;
    Functions: {
      [SUPABASE_V1_FUNCTION_NAMES.recordEvent]: {
        Args: { p_event: BundleEventRow; p_overview: unknown };
        Returns: undefined;
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
