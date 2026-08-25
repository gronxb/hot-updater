import { bare } from "@hot-updater/bare";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({
  path: process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ?? ".env.hotupdater",
});

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
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
  }),
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

  authorityId: "ncdytlrazlpfoyecmdlh",
});
