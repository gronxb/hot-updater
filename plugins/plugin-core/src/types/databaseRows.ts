import type { Platform } from "@hot-updater/core";

export type DatabaseJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly DatabaseJsonValue[]
  | DatabaseJsonObject;

export type DatabaseJsonObject = {
  readonly [key: string]: DatabaseJsonValue;
};

export type DatabaseBundleMetadata = DatabaseJsonObject & {
  readonly app_version?: string;
};

export interface BundleRow {
  readonly id: string;
  readonly platform: Platform;
  readonly file_hash: string;
  readonly git_commit_hash: string | null;
  readonly storage_uri: string;
  readonly archive_byte_size: number;
  readonly metadata: DatabaseBundleMetadata;
  readonly manifest_storage_uri: string | null;
  readonly manifest_file_hash: string | null;
  readonly asset_base_storage_uri: string | null;
}

export interface BundlePatchRow {
  readonly id: string;
  readonly bundle_id: string;
  readonly base_bundle_id: string;
  readonly base_file_hash: string;
  readonly patch_file_hash: string;
  readonly patch_storage_uri: string;
  readonly byte_size: number;
  readonly order_index: number;
}

export interface ReleaseRow {
  readonly id: string;
  readonly revision: number;
  readonly scope_key: string;
  readonly channel_id: string;
  readonly platform: Platform;
  readonly kind: "BUNDLE" | "EMBEDDED";
  readonly bundle_id: string | null;
  readonly strategy: "APP_VERSION" | "FINGERPRINT";
  readonly target_app_version: string | null;
  readonly fingerprint_hash: string | null;
  readonly enabled: boolean;
  readonly should_force_update: boolean;
  readonly message: string | null;
  readonly rollout_cohort_count: number;
  readonly target_cohorts: readonly string[];
  readonly operation: "DEPLOY" | "PROMOTE" | "ROLLBACK";
  readonly source_release_id: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface ReleaseCatalogRow {
  readonly scope_key: string;
  readonly catalog_id: string;
  readonly strategy: "APP_VERSION" | "FINGERPRINT";
  readonly channel_id: string;
  readonly channel_key: string;
  readonly platform: Platform;
  readonly fingerprint_hash: string | null;
  readonly generation: number;
  readonly payload: string;
  readonly catalog_hash: string;
  readonly byte_size: number;
  readonly is_tombstone: boolean;
  readonly updated_at_ms: number;
}

export interface ChannelRow {
  readonly id: string;
  readonly name: string;
}

export type BundleEventRowBase = {
  readonly id: string;
  readonly install_id: string;
  readonly user_id: string | null;
  readonly username: string | null;
  readonly from_release_id: string | null;
  readonly to_release_id: string | null;
  readonly to_bundle_id: string;
  readonly platform: Platform;
  readonly app_version: string;
  readonly channel: string;
  readonly cohort: string;
  readonly fingerprint_hash: string | null;
  readonly sdk_version: string | null;
  readonly received_at_ms: number;
};

export type BundleEventRow =
  | (BundleEventRowBase & {
      readonly type: "UPDATE_APPLIED" | "RECOVERED" | "RELEASE_ADOPTED";
      readonly from_bundle_id: string;
      readonly update_strategy: "fingerprint" | "appVersion";
    })
  | (BundleEventRowBase & {
      readonly type: "UNCHANGED";
      readonly from_bundle_id: null;
      readonly update_strategy: null;
    });

export interface ApiKeyRow {
  readonly id: string;
  readonly hash: string;
  readonly name: string;
  readonly prefix: string;
  readonly role: "client";
  readonly created_at_ms: number;
  readonly revoked_at_ms: number | null;
}

export interface DatabaseModelMap {
  readonly bundles: BundleRow;
  readonly bundle_patches: BundlePatchRow;
  readonly releases: ReleaseRow;
  readonly release_catalogs: ReleaseCatalogRow;
  readonly channels: ChannelRow;
  readonly api_keys: ApiKeyRow;
}

export type DatabaseModel = keyof DatabaseModelMap;
export type DatabaseRow<TModel extends DatabaseModel> =
  DatabaseModelMap[TModel];
export type DatabaseField<TModel extends DatabaseModel> = Extract<
  keyof DatabaseRow<TModel>,
  string
>;
