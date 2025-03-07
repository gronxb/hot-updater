export type Platform = "ios" | "android";

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
   * The target app version of the bundle.
   */
  targetAppVersion: string;
  /**
   * Whether the bundle should force an update.
   */
  shouldForceUpdate: boolean;
  /**
   * Whether the bundle is enabled.
   */
  enabled: boolean;
  /**
   * The file URL of the bundle.
   */
  fileUrl: string;
  /**
   * The hash of the bundle.
   */
  fileHash: string;
  /**
   * The git commit hash of the bundle.
   */
  gitCommitHash: string | null;
  /**
   * The message of the bundle.
   */
  message: string | null;
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

export type BundleArg =
  | string
  | Bundle[]
  | (() => Promise<Bundle[]>)
  | (() => Bundle[]);

export type UpdateStatus = "ROLLBACK" | "UPDATE";

export interface UpdateInfo {
  id: string;
  shouldForceUpdate: boolean;
  fileUrl: string | null;
  message: string | null;
  status: UpdateStatus;
}

export interface GetBundlesArgs {
  platform: Platform;
  bundleId: string;
  minBundleId?: string;
  appVersion: string;
}
