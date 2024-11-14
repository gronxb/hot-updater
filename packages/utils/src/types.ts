export type Platform = "ios" | "android";

export interface Bundle {
  bundleId: string;
  platform: Platform;
  targetVersion: string;
  forceUpdate: boolean;
  enabled: boolean;
  file: string;
  hash: string;
  description?: string;
}

export type BundleArg =
  | string
  | Bundle[]
  | (() => Promise<Bundle[]>)
  | (() => Bundle[]);
