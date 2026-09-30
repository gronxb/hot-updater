import { existsSync } from "node:fs";

import { rock } from "@hot-updater/rock";
import { defineConfig } from "hot-updater";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

export default defineConfig({
  build: rock(),
  server: "./hotUpdater.ts",
  updateStrategy: "appVersion",
});
