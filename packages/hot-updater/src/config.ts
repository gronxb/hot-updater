import type { Config, HotUpdaterConfigOptions } from "@hot-updater/plugin-core";

export const defineConfig = (
  config: Config | ((options: HotUpdaterConfigOptions) => Config),
) => {
  return config;
};
