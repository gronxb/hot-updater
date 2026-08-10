import type {
  BundlePatchRow,
  BundleRow,
  Platform,
} from "@hot-updater/plugin-core";

export type SupabaseBundleRow = {
  [TField in keyof BundleRow]: BundleRow[TField];
};

export type SupabaseBundlePatchRow = {
  [TField in keyof BundlePatchRow]: BundlePatchRow[TField];
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

export type SupabaseManagedAccessKeyRow = {
  readonly created_at_ms: number | string;
  readonly enabled: boolean;
  readonly hash: string;
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly revoked_at_ms: number | string | null;
  readonly role: "client";
};

export type Database = {
  public: {
    Tables: {
      bundles: Table<SupabaseBundleRow>;
      bundle_patches: Table<SupabaseBundlePatchRow>;
      managed_access_keys: Table<SupabaseManagedAccessKeyRow>;
      private_hot_updater_settings: Table<{
        readonly key: string;
        readonly value: string;
      }>;
    };
    Views: { [_ in never]: never };
    Functions: {
      hot_updater_create_bundle_with_patches: {
        Args: {
          p_bundle: SupabaseBundleRow;
          p_patches: readonly SupabaseBundlePatchRow[];
        };
        Returns: undefined;
      };
      hot_updater_update_bundle_with_patches: {
        Args: {
          p_bundle_id: string;
          p_update: Partial<SupabaseBundleRow>;
          p_patches: readonly SupabaseBundlePatchRow[];
        };
        Returns: boolean;
      };
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
