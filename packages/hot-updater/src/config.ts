import type { Config } from "@hot-updater/plugin-core";

export const defineConfig = async (
  config: Config | (() => Config) | (() => Promise<Config>),
): Promise<Config> => (typeof config === "function" ? await config() : config);
