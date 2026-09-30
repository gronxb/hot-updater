import { existsSync } from "node:fs";

import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

export default defineConfig({
  build: bare({
    enableHermes: true,
  }),
  server: "./hotUpdater.ts",
  updateStrategy: "fingerprint",
});
