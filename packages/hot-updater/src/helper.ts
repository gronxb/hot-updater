import type { CliArgs, DeployPlugin, PluginArgs } from "@hot-updater/internal";

export type Config = {
  server: string;
  secretKey: string;
  build: (args: PluginArgs) => Promise<{
    buildPath: string;
    outputs: string[];
  }>;
  deploy: (args: CliArgs) => DeployPlugin;
};

export const defineConfig = (config: Config | (() => Config)): Config =>
  typeof config === "function" ? config() : config;
