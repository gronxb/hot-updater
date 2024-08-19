export const defineConfig = (config) => typeof config === "function" ? config() : config;
