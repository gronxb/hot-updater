import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "plugins/*", "examples-server/*"],
    exclude: [...configDefaults.exclude, "**/lib/**", "**/dist/**"],
  },
});
