import type { Platform } from "@hot-updater/core";

export type DatabaseJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly DatabaseJsonValue[]
  | { readonly [key: string]: DatabaseJsonValue };

export interface BundleRow {
  readonly id: string;
  readonly platform: Platform;
  readonly should_force_update: boolean;
  readonly enabled: boolean;
  readonly file_hash: string;
  readonly git_commit_hash: string | null;
  readonly message: string | null;
  readonly channel: string;
  readonly storage_uri: string;
  readonly target_app_version: string | null;
  readonly fingerprint_hash: string | null;
  readonly metadata: unknown;
  readonly rollout_cohort_count: number;
  readonly target_cohorts: readonly string[] | null;
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
  readonly order_index: number;
}

interface BundleEventRowBase {
  readonly id: string;
  readonly install_id: string;
  readonly user_id: string | null;
  readonly username: string | null;
  readonly to_bundle_id: string;
  readonly platform: Platform;
  readonly app_version: string;
  readonly channel: string;
  readonly cohort: string;
  readonly fingerprint_hash: string | null;
  readonly sdk_version: string | null;
  readonly received_at_ms: number;
}

export type BundleEventRow =
  | (BundleEventRowBase & {
      readonly type: "UPDATE_APPLIED";
      readonly from_bundle_id: string;
      readonly update_strategy: "fingerprint" | "appVersion";
    })
  | (BundleEventRowBase & {
      readonly type: "RECOVERED";
      readonly from_bundle_id: string;
      readonly update_strategy: "fingerprint" | "appVersion";
    })
  | (BundleEventRowBase & {
      readonly type: "UNCHANGED";
      readonly from_bundle_id: null;
      readonly update_strategy: null;
    });

export interface DatabaseModelMap {
  readonly bundles: BundleRow;
  readonly bundle_patches: BundlePatchRow;
  readonly bundle_events: BundleEventRow;
}

export type DatabaseModel = keyof DatabaseModelMap;
export type DatabaseRow<TModel extends DatabaseModel> =
  DatabaseModelMap[TModel];
export type DatabaseField<TModel extends DatabaseModel> = Extract<
  keyof DatabaseRow<TModel>,
  string
>;
