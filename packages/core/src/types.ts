export type Platform = "ios" | "android";

export type CompressionStrategy = "zip" | "tarBrotli" | "tarGzip";

/**
 * Compression format detection information
 */
export const COMPRESSION_FORMATS = {
  zip: {
    magicBytes: [0x50, 0x4b, 0x03, 0x04] as const, // PK..
    extension: ".zip",
    description: "ZIP archive",
  },
  gzip: {
    magicBytes: [0x1f, 0x8b] as const, // First two bytes
    extension: ".tar.gz",
    description: "GZIP compressed TAR archive",
  },
  tar: {
    // TAR archives have "ustar" at offset 257
    magicBytes: [0x75, 0x73, 0x74, 0x61, 0x72] as const, // "ustar"
    offset: 257,
    extension: ".tar",
    description: "TAR archive",
  },
  brotli: {
    // Brotli has no standard magic bytes, relies on metadata
    magicBytes: null,
    extension: ".tar.br",
    description: "Brotli compressed TAR archive",
  },
} as const;

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
}

/**
 * The update info for the app layer.
 * This is the update info that is used by the app.
 */
export interface AppUpdateInfo extends UpdateInfo {
  fileUrl: string | null;
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
