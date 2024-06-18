export type Config = {
  updateServer: string;
  build: (cwd: string) => void;
  deploy: (cwd: string) => void;
};

export const defineConfig = (config: Config | (() => Config)): Config =>
  typeof config === "function" ? config() : config;
