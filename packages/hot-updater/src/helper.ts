export interface PluginArgs {
  platform: "ios" | "android";
  cwd: string;
  server: string;
  secretKey: string;
}

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
