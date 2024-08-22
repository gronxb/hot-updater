import type { Config } from "@hot-updater/internal";

export const defineConfig = (config: Config | (() => Config)): Config =>
  typeof config === "function" ? config() : config;
