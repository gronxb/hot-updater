import { existsSync } from "node:fs";

import { expo } from "@hot-updater/expo";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { defineConfig, secret } from "hot-updater";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

export default defineConfig({
  build: expo(),
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
  fingerprint: {
    debug: true,
  },
  // Bundle signing is enabled for this example.
  // Run: npx hot-updater secrets issue bundle-signing-key
  signing: secret("bundle-signing-key"),
});
