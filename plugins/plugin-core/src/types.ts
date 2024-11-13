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
    targetBundleId: string,
    newSource: Partial<UpdateSource>,
  ) => Promise<void>;
  setUpdateSources: (sources: UpdateSource[]) => Promise<void>;
  appendUpdateSource: (source: UpdateSource) => Promise<void>;
  commitUpdateSource: () => Promise<void>;

  uploadBundle: (
    platform: Platform,
    bundleId: string,
    bundlePath: string,
  ) => Promise<{
    file: string;
  }>;
  deleteBundle: (platform: Platform, bundleId: string) => Promise<string>;
}

export type Config = {
  server: string;
  secretKey: string;
  build: (args: BuildPluginArgs) => Promise<{
    buildPath: string;
    bundleId: string;
  }>;
  deploy: (args: BasePluginArgs) => DeployPlugin;
};
