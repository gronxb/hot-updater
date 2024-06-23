export interface PluginArgs {
  platform: "ios" | "android";
  cwd: string;
}

export type Config = {
  server: string;
  build: (args: PluginArgs) => void;
  deploy: (args: PluginArgs) => {
    upload: () => void;
  };
};

export const defineConfig = (config: Config | (() => Config)): Config =>
  typeof config === "function" ? config() : config;
