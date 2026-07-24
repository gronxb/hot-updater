import type {
  BundlePatchRow,
  BundleRow,
  DatabaseRow,
  Platform,
} from "@hot-updater/plugin-core";

type BundleEventPersistenceRow = DatabaseRow<"bundle_events">;

export type SupabaseBundleRow = {
  [TField in keyof BundleRow]: BundleRow[TField];
};

export type SupabaseBundlePatchRow = {
  [TField in keyof BundlePatchRow]: BundlePatchRow[TField];
};

export type SupabaseBundleEventPersistenceRow = {
  [TField in keyof BundleEventPersistenceRow]: BundleEventPersistenceRow[TField];
};

type Table<TRow> = {
  Row: TRow;
  Insert: TRow;
  Update: Partial<TRow>;
  Relationships: [];
};

type UpdateInfoRow = {
  readonly id: string;
  readonly should_force_update: boolean;
  readonly message: string | null;
  readonly status: "UPDATE" | "ROLLBACK";
  readonly storage_uri: string | null;
  readonly file_hash: string | null;
};

export type Database = {
  public: {
    Tables: {
      bundles: Table<SupabaseBundleRow>;
      bundle_patches: Table<SupabaseBundlePatchRow>;
      bundle_events: Table<SupabaseBundleEventPersistenceRow>;
    };
    Views: { [_ in never]: never };
    Functions: {
      get_channels: {
        Args: Record<never, never>;
        Returns: { readonly channel: string }[];
      };
      get_target_app_version_list: {
        Args: {
          app_platform: Platform;
          min_bundle_id: string;
        };
        Returns: {
          target_app_version: string | null;
        }[];
      };
      get_update_info_by_app_version: {
        Args: {
          app_platform: Platform;
          app_version: string;
          bundle_id: string;
          min_bundle_id: string;
          target_channel: string;
          target_app_version_list: string[];
          cohort: string | null;
        };
        Returns: UpdateInfoRow[];
      };
      get_update_info_by_fingerprint_hash: {
        Args: {
          app_platform: Platform;
          bundle_id: string;
          min_bundle_id: string;
          target_channel: string;
          target_fingerprint_hash: string;
          cohort: string | null;
        };
        Returns: UpdateInfoRow[];
      };
    };
  };
};
