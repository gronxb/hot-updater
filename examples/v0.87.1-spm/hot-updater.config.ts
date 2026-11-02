import { existsSync } from "node:fs";

import { bare } from "@hot-updater/bare";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { defineConfig, secret } from "hot-updater";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

export default defineConfig({
  nativeBuild: {
    ios: {
      release: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
        // Swift Package Manager project: `pnpm spm` replaces `pod install`.
        installPods: false,
      },
    },
    android: {
      releaseApk: { packageName: "com.hotupdaterexample", aab: false },
    },
  },
  build: bare({ enableHermes: true }),
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
  updateStrategy: "appVersion",
});
