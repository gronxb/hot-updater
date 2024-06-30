import type { DeployPlugin, PluginArgs } from "@hot-updater/internal";

export type Config = {
  server: string;
  secretKey: string;
  build: (args: PluginArgs) => Promise<{
    buildPath: string;
    outputs: string[];
  }>;
  deploy: (args: PluginArgs) => DeployPlugin;
};

export const defineConfig = (config: Config | (() => Config)): Config =>
  typeof config === "function" ? config() : config;
