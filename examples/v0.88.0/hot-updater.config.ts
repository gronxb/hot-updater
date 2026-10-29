import { existsSync } from "node:fs";

import { bare } from "@hot-updater/bare";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { defineConfig, secret } from "hot-updater";
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
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: secret("HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY"),
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: secret("HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY"),
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
