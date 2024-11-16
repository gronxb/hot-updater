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
  file: string;
  /**
   * The hash of the bundle.
   */
  hash: string;
  /**
   * The description of the bundle.
   */
  description?: string;
}

export type BundleArg =
  | string
  | Bundle[]
  | (() => Promise<Bundle[]>)
  | (() => Bundle[]);
