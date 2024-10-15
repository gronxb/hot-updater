export type Platform = "ios" | "android";

export interface UpdateSource {
  platform: Platform;
  targetVersion: string;
  bundleVersion: number;
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
