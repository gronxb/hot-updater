export type HotUpdaterReadStrategy = () =>
  | Promise<{
      updateJson: string | null;
      files: string[];
    }>
  | {
      updateJson: string | null;
      files: string[];
    };

export type Platform = "ios" | "android";

export interface BasePluginArgs {
  cwd: string;
  log?: {
    info: (message: string) => void;
    success: (message: string) => void;
    error: (message: string) => void;
  };
  spinner?: {
    message: (message: string) => void;
    error: (message: string) => void;
    done: (message: string) => void;
  };
}

export interface BuildPluginArgs extends BasePluginArgs {
  platform: Platform;
}

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

export interface DeployPlugin {
  getUpdateJson: (refresh?: boolean) => Promise<UpdateSource[]>;
  updateUpdateJson: (
    targetBundleVersion: number,
    newSource: UpdateSource,
  ) => Promise<void>;
  setUpdateJson: (sources: UpdateSource[]) => Promise<void>;
  appendUpdateJson: (source: UpdateSource) => Promise<void>;
  commitUpdateJson: () => Promise<void>;

  uploadBundle: (
    platform: Platform,
    bundleVersion: number,
    bundlePath: string,
  ) => Promise<{
    file: string;
  }>;
  deleteBundle: (platform: Platform, bundleVersion: number) => Promise<string>;
}
