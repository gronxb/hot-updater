export type Config = {
  deploy: (() => void)[];
};

export const defineConfig = (config: Config | (() => Config)): Config =>
  typeof config === "function" ? config() : config;
