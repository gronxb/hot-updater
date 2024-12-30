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
   * The target version of the bundle.
   */
  targetVersion: string;
  /**
   * Whether the bundle should force an update.
   */
  forceUpdate: boolean;
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

export type BundleArg =
  | string
  | Bundle[]
  | (() => Promise<Bundle[]>)
  | (() => Bundle[]);

export type UpdateStatus = "ROLLBACK" | "UPDATE";

export interface UpdateInfo {
  id: string;
  forceUpdate: boolean;
  fileUrl: string | null;
  fileHash: string | null;
  status: UpdateStatus;
}

export interface GetBundlesArgs {
  platform: Platform;
  bundleId: string;
  appVersion: string;
}
