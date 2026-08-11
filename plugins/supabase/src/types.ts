import type {
  BundlePatchRow,
  BundleRow,
  BundleEventRowBase,
  ClientAccessKeyRow,
  Platform,
} from "@hot-updater/plugin-core";

export type SupabaseBundleRow = {
  [TField in keyof BundleRow]: BundleRow[TField];
};

export type SupabaseBundlePatchRow = {
  [TField in keyof BundlePatchRow]: BundlePatchRow[TField];
};

export type SupabaseBundleEventRow = BundleEventRowBase & {
  readonly type: "UPDATE_APPLIED" | "RECOVERED" | "UNCHANGED";
  readonly from_bundle_id: string | null;
  readonly update_strategy: "fingerprint" | "appVersion" | null;
};

export type SupabaseClientAccessKeyRow = {
  [TField in keyof ClientAccessKeyRow]: ClientAccessKeyRow[TField];
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
      bundle_events: Table<SupabaseBundleEventRow>;
      client_access_keys: Table<SupabaseClientAccessKeyRow>;
    };
    Views: { [_ in never]: never };
    Functions: {
      hot_updater_commit: {
        Args: {
          p_mutations: readonly unknown[];
        };
        Returns: {
          readonly applied: boolean;
          readonly missingBundleId?: string;
        };
      };
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
