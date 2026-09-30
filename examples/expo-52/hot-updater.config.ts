import { existsSync } from "node:fs";

import { expo } from "@hot-updater/expo";
import { defineConfig } from "hot-updater";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

export default defineConfig({
  build: expo(),
  server: "./hotUpdater.ts",
  updateStrategy: "appVersion",
  fingerprint: {
    debug: true,
  },
  // Bundle signing is enabled for this example.
  // Run: npx hot-updater keys generate
  signing: {
    enabled: true,
    privateKeyPath: "./keys/private-key.pem",
  },
});
