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
      [SUPABASE_V1_TABLE_NAMES.apiKeys]: Table<SupabaseApiKeyRow>;
      [SUPABASE_V1_TABLE_NAMES.releaseCatalogs]: Table<SupabaseReleaseCatalogRow>;
      [SUPABASE_V1_TABLE_NAMES.releases]: Table<SupabaseReleaseRow>;
    };
    Views: { [_ in never]: never };
    Functions: {
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
      [SUPABASE_V1_FUNCTION_NAMES.insightsPrepare]: {
        Args: {
          p_max_items: number;
          p_batch: readonly Record<string, unknown>[];
          p_batch_bytes: number;
        };
        Returns: Record<string, unknown>;
      };
      [SUPABASE_V1_FUNCTION_NAMES.insightsPrepareRead]: {
        Args: { p_max_items: number };
        Returns: Record<string, unknown>;
      };
      [SUPABASE_V1_FUNCTION_NAMES.insightsAppend]: {
        Args: {
          p_event: BundleEventRow;
          p_event_bytes: number;
          p_install_key: string;
          p_cohort_order: string;
          p_aliases: readonly {
            kind: "installationId" | "userId" | "username";
            original: string;
            normalized: string;
          }[];
        };
        Returns: undefined;
      };
      [SUPABASE_V1_FUNCTION_NAMES.insightsEventPage]: {
        Args: {
          p_scope: "all" | "installation" | "bundle";
          p_scope_id: string | null;
          p_before_received_at_ms: number;
          p_since_received_at_ms: number;
          p_limit: number;
          p_cursor_received_at_ms: number | null;
          p_cursor_id: string | null;
        };
        Returns: {
          rows: BundleEventRow[];
          hasMore: boolean;
          sourceGeneration: string;
        };
      };
      [SUPABASE_V1_FUNCTION_NAMES.insightsInstallationPage]: {
        Args: {
          p_selector: Record<string, unknown>;
          p_limit: number;
          p_after_key: string | null;
          p_after_ordinal: string | null;
          p_publication_id: string | null;
          p_min_as_of_ms: number | null;
          p_now_ms: number;
        };
        Returns: Record<string, unknown>;
      };
      [SUPABASE_V1_FUNCTION_NAMES.insightsSearchStep]: {
        Args: {
          p_job_id: string;
          p_max_items: number;
          p_max_bytes: number;
        };
        Returns: Record<string, unknown>;
      };
      [SUPABASE_V1_FUNCTION_NAMES.insightsReport]: {
        Args: {
          p_query: Record<string, unknown>;
          p_min_as_of_ms: number | null;
          p_now_ms: number;
        };
        Returns: Record<string, unknown>;
      };
      [SUPABASE_V1_FUNCTION_NAMES.insightsReportStep]: {
        Args: {
          p_job_id: string;
          p_max_items: number;
          p_max_bytes: number;
        };
        Returns: Record<string, unknown>;
      };
      [SUPABASE_V1_FUNCTION_NAMES.insightsReportPage]: {
        Args: {
          p_publication_id: string;
          p_section: Record<string, unknown>;
          p_limit: number;
          p_after: unknown;
        };
        Returns: Record<string, unknown>;
      };
      [SUPABASE_V1_FUNCTION_NAMES.insightsPrune]: {
        Args: {
          p_before_ms: number;
          p_max_items: number;
          p_max_bytes: number;
        };
        Returns: Record<string, unknown>;
      };
    };
  };
};
