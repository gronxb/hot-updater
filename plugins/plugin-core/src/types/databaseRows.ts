import type { Platform } from "@hot-updater/protocol";

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
  readonly git_commit_hash: string | null;
  readonly metadata: DatabaseBundleMetadata;
  readonly manifest_storage_uri: string;
  readonly manifest_file_hash: string;
  readonly asset_base_storage_uri: string;
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
  readonly kind: "BUNDLE";
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
