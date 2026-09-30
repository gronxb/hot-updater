import { existsSync } from "node:fs";

import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

export default defineConfig({
  platform: {},
  nativeBuild: {
    android: {
      debugApk: {
        packageName: "com.hotupdaterexample",
        aab: false,
        variant: "Debug",
      },
      releaseApk: { packageName: "com.hotupdaterexample", aab: false },
      releaseAab: { packageName: "com.hotupdaterexample", aab: true },
    },
    ios: {
      release: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
        installPods: true,
        // exportOptionsPlist: "./ios/HotUpdaterExample/ExportOptions.plist",
      },
      debug: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Debug",
        installPods: true,
        // exportOptionsPlist: "./ios/HotUpdaterExample/ExportOptions.plist",
      },
    },
  },
  build: bare({ enableHermes: true }),
  server: "./hotUpdater.ts",
  updateStrategy: "fingerprint",
});
