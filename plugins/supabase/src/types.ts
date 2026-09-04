import type {
  BundlePatchRow,
  BundleRow,
  BundleEventRow,
  InsightsInstallationRow,
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

export type SupabaseBundleInstallationRow = InsightsInstallationRow;

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
      [SUPABASE_V1_TABLE_NAMES.bundleInstallations]: Table<SupabaseBundleInstallationRow>;
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
    };
  };
};
