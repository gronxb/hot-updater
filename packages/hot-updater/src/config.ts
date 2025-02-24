import type { Config, Platform } from "@hot-updater/plugin-core";

export interface HotUpdaterConfigOptions {
  platform: Platform | "console";
}

export const defineConfig = async (
  config:
    | Config
    | ((options: HotUpdaterConfigOptions) => Config)
    | ((options: HotUpdaterConfigOptions) => Promise<Config>),
) => {
  return config;
};
