export type Config = {
  updateServer: string;
  build: (platform: "ios" | "android", cwd: string) => void;
  deploy: (cwd: string) => {
    upload: () => void;
  };
};

export const defineConfig = (config: Config | (() => Config)): Config =>
  typeof config === "function" ? config() : config;
