import type {
  BundlePatchRow,
  BundleRow,
  BundleEventRow,
  ChannelRow,
  ChannelDeleteResult,
  ClientAccessKeyRow,
  DatabaseCommit,
  DatabaseCommitResult,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";

export type SupabaseBundleRow = {
  [TField in keyof BundleRow]: BundleRow[TField];
};

export type SupabaseBundlePatchRow = {
  [TField in keyof BundlePatchRow]: BundlePatchRow[TField];
};

export type SupabaseBundleEventRow = BundleEventRow;

export type SupabaseClientAccessKeyRow = {
  [TField in keyof ClientAccessKeyRow]: ClientAccessKeyRow[TField];
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
      bundles: Table<SupabaseBundleRow>;
      bundle_patches: Table<SupabaseBundlePatchRow>;
      channels: Table<SupabaseChannelRow>;
      bundle_events: Table<SupabaseBundleEventRow>;
      client_access_keys: Table<SupabaseClientAccessKeyRow>;
      release_catalogs: Table<SupabaseReleaseCatalogRow>;
      releases: Table<SupabaseReleaseRow>;
    };
    Views: { [_ in never]: never };
    Functions: {
      hot_updater_commit: {
        Args: {
          p_commit: DatabaseCommit;
        };
        Returns: DatabaseCommitResult;
      };
      hot_updater_delete_channel: {
        Args: {
          p_id: string;
        };
        Returns: ChannelDeleteResult;
      };
    };
  };
};
