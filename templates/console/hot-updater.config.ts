import { defineConfig } from "hot-updater";

const missingPlugin = (name: string): never => {
  throw new Error(
    `Configure the Hot Updater ${name} plugin before running the console.`,
  );
};

export default defineConfig({
  updateStrategy: "appVersion",
  build: () => missingPlugin("build"),
  storage: () => missingPlugin("storage"),
  database: () => missingPlugin("database"),
});
