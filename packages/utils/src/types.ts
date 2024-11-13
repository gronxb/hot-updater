export type Platform = "ios" | "android";

export interface UpdateSource {
  bundleId: string;
  platform: Platform;
  targetVersion: string;
  forceUpdate: boolean;
  enabled: boolean;
  file: string;
  hash: string;
  description?: string;
}

export type UpdateSourceArg =
  | string
  | UpdateSource[]
  | (() => Promise<UpdateSource[]>)
  | (() => UpdateSource[]);
