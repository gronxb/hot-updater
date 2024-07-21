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

export interface CliArgs {
  cwd: string;
  spinner?: {
    message: (message: string) => void;
    stop: (message: string, code: number) => void;
  };
}
export interface PluginArgs extends CliArgs {
  cwd: string;
  server: string;
  secretKey: string;
  targetVersion?: string;
}

export interface UpdateSource {
  platform: Platform;
  targetVersion: string;
  bundleVersion: number;
  forceUpdate: boolean;
  enabled: boolean;
  files: string[];
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
  ) => Promise<{
    files: string[];
  }>;
  deleteBundle: (platform: Platform, bundleVersion: number) => Promise<void>;
}
