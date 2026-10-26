import { existsSync } from "node:fs";

import { bare } from "@hot-updater/bare";
import { standaloneRepository } from "@hot-updater/standalone";
// @ts-ignore
import { fileStorage } from "/Volumes/SSD_2TB/tmp/nbc-verify/fileStorage.mjs";
import { defineConfig } from "hot-updater";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";

const envFilePath =
  process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ?? ".env.hotupdater";
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

export default defineConfig({
  nativeBuild: {
    ios: {
      release: {
        bundleIdentifier: "org.reactjs.native.example.HotUpdaterExample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
        installPods: true,
      },
      // CI builds this one through `hot-updater native-build ios` from a fresh ios/.
      releaseSimulator: {
        bundleIdentifier: "org.reactjs.native.example.HotUpdaterExample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
        simulator: true,
        installPods: true,
      },
    },
    android: {
      releaseApk: { packageName: "com.hotupdaterexample", aab: false },
    },
  },
  build: bare({ enableHermes: true, resetCache: false }),
  storage: fileStorage(),
  database: standaloneRepository({
    baseUrl: "http://127.0.0.1:3941/hot-updater/admin",
  }),
  plugins: [apiKeys(), insights(), remoteConfig()],
  fingerprint: { debug: true },
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
