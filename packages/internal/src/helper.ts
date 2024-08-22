import type { BasePluginArgs, BuildPluginArgs, DeployPlugin } from "./types";

export type Config = {
  server: string;
  secretKey: string;
  build: (args: BuildPluginArgs) => Promise<{
    buildPath: string;
    outputs: string[];
  }>;
  deploy: (args: BasePluginArgs) => DeployPlugin;
};
