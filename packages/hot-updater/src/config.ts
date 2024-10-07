import type { Config } from "@hot-updater/plugin-core";

export const defineConfig = (config: Config | (() => Config)): Config =>
  typeof config === "function" ? config() : config;
