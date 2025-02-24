import type { Config, HotUpdaterConfigOptions } from "@hot-updater/plugin-core";

export const defineConfig = async (
  config:
    | Config
    | ((options: HotUpdaterConfigOptions) => Config)
    | ((options: HotUpdaterConfigOptions) => Promise<Config>),
) => {
  return config;
};
