export type Platform = "ios" | "android";

export type BundleMetadata = {
  app_version?: string;
};

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
   * Rollout percentage (0-100). Controls gradual rollout to devices.
   * - 0: No devices receive this update
   * - 50: ~50% of devices eligible based on device ID hash
   * - 100 or null: All devices receive this update (full rollout)
   *
   * @default 100
   */
  rolloutPercentage?: number | null;

  /**
   * Target specific device IDs for this update.
   * If provided, only these devices will receive the update.
   * If empty/null, rolloutPercentage-based rollout is used.
   *
   * NOTE: This field is stored in database but should NOT be returned to
   * update-check clients for security reasons. Server uses it for rollout
   * decisions only.
   */
  targetDeviceIds?: string[] | null;
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
   * Device/user identifier used for server-side rollout decisions.
   * If omitted, rollout is treated as 100% for backward compatibility.
   */
  deviceId?: string;
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
   * Device/user identifier used for server-side rollout decisions.
   * If omitted, rollout is treated as 100% for backward compatibility.
   */
  deviceId?: string;
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
