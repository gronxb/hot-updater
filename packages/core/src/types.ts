export type Platform = "ios" | "android";

export type IncrementalManifestKind = "bundle" | "asset";

export interface IncrementalManifestEntry {
  path: string;
  hash: string;
  size: number;
  kind: IncrementalManifestKind;
}

export interface IncrementalPatchInfo {
  fileUrl: string;
  fileHash: string;
  size: number;
}

export interface IncrementalChangedAsset {
  path: string;
  fileUrl: string;
  hash: string;
  size: number;
}

export interface IncrementalPatchCacheEntry {
  storageUri: string;
  fileHash: string;
  size: number;
}

export interface BundleIncrementalMetadata {
  bundleHash: string;
  manifest: IncrementalManifestEntry[];
  patchCache?: Record<string, IncrementalPatchCacheEntry>;
}

export type BundleMetadata = {
  app_version?: string;
  incremental?: BundleIncrementalMetadata;
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
}

type SnakeCase<S extends string> = S extends `${infer T}${infer U}`
  ? `${T extends Capitalize<T> ? "_" : ""}${Lowercase<T>}${SnakeCase<U>}`
  : S;

// Utility type to recursively map object keys to snake_case
type SnakeKeyObject<T> = T extends Record<string, any>
  ? {
      [K in keyof T as SnakeCase<Extract<K, string>>]: T[K] extends object
        ? SnakeKeyObject<T[K]>
        : T[K];
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
  /**
   * Optional incremental update plan.
   *
   * When present, clients should ignore `fileUrl` and use this plan:
   * - patch main Hermes bundle via bspatch
   * - download changed assets only
   * - reconstruct target directory from manifest
   */
  incremental?: {
    protocol: "bsdiff-v1";
    baseBundleId: string;
    baseBundleHash: string;
    bundlePath: string;
    patch: IncrementalPatchInfo;
    manifest: IncrementalManifestEntry[];
    changedAssets: IncrementalChangedAsset[];
  };
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
   * The fingerprint hash of the bundle.
   */
  fingerprintHash: string;
  /**
   * SHA256 hash of the currently active bundle file.
   * Used for incremental diff planning.
   */
  currentHash?: string | null;
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
   * The current app version.
   */
  appVersion: string;
  /**
   * SHA256 hash of the currently active bundle file.
   * Used for incremental diff planning.
   */
  currentHash?: string | null;
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
  currentHash?: string | null;
};
