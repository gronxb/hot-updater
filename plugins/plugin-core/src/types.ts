import type { Platform, UpdateSource } from "@hot-updater/core";

export type { Platform, UpdateSource } from "@hot-updater/core";

export type HotUpdaterReadStrategy = () =>
  | Promise<{
      updateJson: string | null;
      files: string[];
    }>
  | {
      updateJson: string | null;
      files: string[];
    };

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

export type Config = {
  server: string;
  secretKey: string;
  build: (args: BuildPluginArgs) => Promise<{
    buildPath: string;
    outputs: string[];
  }>;
  deploy: (args: BasePluginArgs) => DeployPlugin;
};
