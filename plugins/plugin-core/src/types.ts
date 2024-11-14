import type { Bundle, Platform } from "@hot-updater/utils";

export type { Platform, Bundle } from "@hot-updater/utils";

export interface BasePluginArgs {
  cwd: string;
}

export interface BuildPluginArgs extends BasePluginArgs {
  platform: Platform;
}

export interface DeployPlugin {
  getBundles: (refresh?: boolean) => Promise<Bundle[]>;
  updateBundle: (
    targetBundleId: string,
    newBundle: Partial<Bundle>,
  ) => Promise<void>;
  setBundles: (bundles: Bundle[]) => Promise<void>;
  appendBundle: (bundles: Bundle) => Promise<void>;
  commitBundle: () => Promise<void>;

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
