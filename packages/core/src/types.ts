export type Platform = "ios" | "android";

export type BundleMetadata = {
  app_version?: string;
  manifest_storage_uri?: string;
  manifest_file_hash?: string;
  asset_base_storage_uri?: string;
  diff_base_bundle_id?: string;
  hbc_patch_algorithm?: "bsdiff";
  hbc_patch_asset_path?: string;
  hbc_patch_base_file_hash?: string;
  hbc_patch_file_hash?: string;
  hbc_patch_storage_uri?: string;
};

export interface ChangedAssetPatch {
  algorithm: "bsdiff";
  baseBundleId: string;
  baseFileHash: string;
  patchFileHash: string;
  patchUrl: string;
}

export interface ChangedAsset {
  fileUrl: string;
  fileHash: string;
  patch?: ChangedAssetPatch | null;
}

export interface Bundle {
  /**
   * The unique identifier for the bundle. uuidv7
   */
  id: string;
  /**
   * The platform the bundle is for.
   */
  platform: Platform;
  /**
   * Whether the bundle should force an update.
   */
  shouldForceUpdate: boolean;
  /**
   * Whether the bundle is enabled.
   */
  enabled: boolean;
  /**
   * The hash of the bundle.
   */
  fileHash: string;
  /**
   * The storage key of the bundle.
   * @example "s3://my-bucket/my-app/00000000-0000-0000-0000-000000000000/bundle.zip"
   * @example "r2://my-bucket/my-app/00000000-0000-0000-0000-000000000000/bundle.zip"
   * @example "firebase-storage://my-bucket/my-app/00000000-0000-0000-0000-000000000000/bundle.zip"
   * @example "storage://my-app/00000000-0000-0000-0000-000000000000/bundle.zip"
   */
  storageUri: string;
  /**
   * The git commit hash of the bundle.
   */
  gitCommitHash: string | null;
  /**
   * The message of the bundle.
   */
  message: string | null;
  /**
   * The name of the channel where the bundle is deployed.
   *
   * Examples:
   * - production: Production channel for end users
   * - development: Development channel for testing
   * - staging: Staging channel for quality assurance before production
   * - app-name: Channel for specific app instances (e.g., my-app, app-test)
   *
   * Different channel values can be used based on each app's requirements.
   */
  channel: string;
  /**
   * The target app version of the bundle.
   */
  targetAppVersion: string | null;
  /**
   * The fingerprint hash of the bundle.
   */
  fingerprintHash: string | null;
  /**
   * The metadata of the bundle.
   */
  metadata?: BundleMetadata;

  /**
   * Rollout cohort count (0-1000). Controls gradual rollout to numeric cohorts.
   * - 0: No cohorts receive this update
   * - 250: 25.0% of numeric cohorts receive this update
   * - 1000 or null: All numeric cohorts receive this update (full rollout)
   *
   * @default 1000
   */
  rolloutCohortCount?: number | null;

  /**
   * Target specific cohorts for this update.
   * If provided, only these cohorts will receive the update.
   * If empty/null, rolloutCohortCount-based rollout is used.
   *
   * NOTE: This field is stored in database but should NOT be returned to
   * update-check clients for security reasons. Server uses it for rollout
   * decisions only.
   */
  targetCohorts?: string[] | null;
}

type SnakeCase<S extends string> = S extends `${infer T}${infer U}`
  ? T extends "_"
    ? `_${SnakeCase<U>}`
    : T extends "-"
      ? `-${SnakeCase<U>}`
      : T extends Lowercase<T>
        ? `${T}${SnakeCase<U>}`
        : `_${Lowercase<T>}${SnakeCase<U>}`
  : S;

// Utility type to recursively map object keys to snake_case
type SnakeKeyObject<T> = T extends readonly (infer U)[]
  ? SnakeKeyObject<U>[]
  : T extends Record<string, any>
    ? {
        [K in keyof T as SnakeCase<Extract<K, string>>]: SnakeKeyObject<T[K]>;
      }
    : T;

export type SnakeCaseBundle = SnakeKeyObject<Bundle>;

export type UpdateStatus = "ROLLBACK" | "UPDATE";

/**
 * The update info for the database layer.
 * This is the update info that is used by the database.
 */
export interface UpdateInfo {
  id: string;
  shouldForceUpdate: boolean;
  message: string | null;
  status: UpdateStatus;
  storageUri: string | null;
  fileHash: string | null;
  /**
   * Rollout cohort count (0-1000). Controls gradual rollout to numeric cohorts.
   */
  rolloutCohortCount?: number | null;
  /**
   * Target specific cohorts for this update.
   * Used internally for rollout decisions.
   */
  targetCohorts?: string[] | null;
}

/**
 * The update info for the app layer.
 * This is the update info that is used by the app.
 */
export interface AppUpdateInfo extends Omit<UpdateInfo, "storageUri"> {
  fileUrl: string | null;
  /**
   * SHA256 hash of the bundle file, optionally with embedded signature.
   * Format when signed: "sig:<base64_signature>"
   * Format when unsigned: "<hex_hash>" (64-character lowercase hex)
   * The client parses this to extract signature for native verification.
   */
  fileHash: string | null;
  /**
   * Optional manifest artifact for manifest-driven updates.
   * When present with `changedAssets`, native can download and verify a signed
   * manifest, then assemble the next bundle directory from reused and changed
   * files while keeping archive fallback available through `fileUrl`.
   */
  manifestUrl?: string | null;
  /**
   * SHA256 hash of the manifest file, optionally with embedded signature.
   * Follows the same `sig:<base64_signature>` or plain hex format as `fileHash`.
   */
  manifestFileHash?: string | null;
  /**
   * Per-file download URLs for assets whose hash differs from the client's
   * current manifest, or for all assets when the server cannot reuse a base
   * manifest. Keys are manifest-relative file paths.
   */
  changedAssets?: Record<string, ChangedAsset> | null;
}

export type UpdateStrategy = "fingerprint" | "appVersion";

export type FingerprintGetBundlesArgs = {
  _updateStrategy: "fingerprint";
  platform: Platform;
  /**
   * The current bundle id of the app.
   */
  bundleId: string;
  /**
   * Minimum bundle id that should be used.
   * This value is generated at build time via getMinBundleId().
   *
   * @default "00000000-0000-0000-0000-000000000000"
   */
  minBundleId?: string;
  /**
   * The name of the channel where the bundle is deployed.
   *
   * @default "production"
   *
   * Examples:
   * - production: Production channel for end users
   * - development: Development channel for testing
   * - staging: Staging channel for quality assurance before production
   * - app-name: Channel for specific app instances (e.g., my-app, app-test)
   */
  channel?: string;
  /**
   * Cohort identifier used for server-side rollout decisions.
   */
  cohort?: string;
  /**
   * The fingerprint hash of the bundle.
   */
  fingerprintHash: string;
};

export type AppVersionGetBundlesArgs = {
  _updateStrategy: "appVersion";
  platform: Platform;
  /**
   * The current bundle id of the app.
   */
  bundleId: string;
  /**
   * Minimum bundle id that should be used.
   * This value is generated at build time via getMinBundleId().
   *
   * @default "00000000-0000-0000-0000-000000000000"
   */
  minBundleId?: string;
  /**
   * The name of the channel where the bundle is deployed.
   *
   * @default "production"
   *
   * Examples:
   * - production: Production channel for end users
   * - development: Development channel for testing
   * - staging: Staging channel for quality assurance before production
   * - app-name: Channel for specific app instances (e.g., my-app, app-test)
   */
  channel?: string;
  /**
   * Cohort identifier used for server-side rollout decisions.
   */
  cohort?: string;
  /**
   * The current app version.
   */
  appVersion: string;
};

export type GetBundlesArgs =
  | FingerprintGetBundlesArgs
  | AppVersionGetBundlesArgs;

export type UpdateBundleParams = {
  platform: Platform;
  bundleId: string;
  minBundleId: string;
  channel: string;
  appVersion: string;
  fingerprintHash: string | null;
};
