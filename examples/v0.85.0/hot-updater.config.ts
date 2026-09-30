import { existsSync } from "node:fs";

import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";

const envFilePath =
  process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ?? ".env.hotupdater";
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

export default defineConfig({
  nativeBuild: {
    android: {
      debugApk: {
        packageName: "com.hotupdaterexample",
        aab: false,
        variant: "Debug",
      },
      releaseApk: {
        packageName: "com.hotupdaterexample",
        aab: false,
      },
    },
    ios: {
      debug: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Debug",
        installPods: false,
        simulator: true,
      },
      release: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
        installPods: true,
      },
    },
  },

  build: bare({ enableHermes: true, resetCache: false }),
  // Each managed E2E profile points at its provider's definition in servers/.
  server: "./servers/cloudflare.ts",
  fingerprint: {
    debug: true,
  },
  /* E2E_AUTO_PATCH_CONFIG_START */
  patch: {
    enabled: true,
    maxBaseBundles: 2,
  },
  /* E2E_AUTO_PATCH_CONFIG_END */
  updateStrategy: "appVersion",
  signing: {
    enabled: true,
    privateKeyPath: "./keys/private-key.pem",
  },
});
