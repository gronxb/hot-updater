import { defineConfig } from "hot-updater";

export default defineConfig({
  console: {
    gitUrl: process.env.GIT_URL,
  },
  build: async () => null,
  storage: () => {
    throw new Error("Configure the storage provider for this deployment.");
  },
  database: () => {
    throw new Error("Configure the database provider for this deployment.");
  },
});
