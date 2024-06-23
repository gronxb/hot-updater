import type { PluginArgs } from "@hot-updater/internal";

export type Config = {
  server: string;
  secretKey: string;
  build: (args: PluginArgs) => void;
  deploy: (args: PluginArgs) => {
    upload: () => void;
  };
};

export const defineConfig = (config: Config | (() => Config)): Config =>
  typeof config === "function" ? config() : config;
