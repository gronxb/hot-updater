import type { Platform, UpdateSource } from "@hot-updater/utils";

export type { Platform, UpdateSource } from "@hot-updater/utils";

export interface BasePluginArgs {
  cwd: string;
}

export interface BuildPluginArgs extends BasePluginArgs {
  platform: Platform;
}

export interface DeployPlugin {
  getUpdateSources: (refresh?: boolean) => Promise<UpdateSource[]>;
  updateUpdateSource: (
    targetBundleVersion: number,
    newSource: Partial<UpdateSource>,
  ) => Promise<void>;
  setUpdateSources: (sources: UpdateSource[]) => Promise<void>;
  appendUpdateSource: (source: UpdateSource) => Promise<void>;
  commitUpdateSource: () => Promise<void>;

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
