export type HotUpdaterReadStrategy = () =>
  | Promise<{
      updateJson: string | null;
      files: string[];
    }>
  | {
      updateJson: string | null;
      files: string[];
    };

export interface CliArgs {
  platform: "ios" | "android";
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
  platform: "ios" | "android";
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
  getUpdateJson: () => Promise<UpdateSource[] | null>;
  uploadBundle: (bundleVersion: number) => Promise<{
    files: string[];
  }>;
  uploadUpdateJson: (source: UpdateSource) => Promise<void>;
}
