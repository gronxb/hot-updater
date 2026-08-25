import { expo } from "@hot-updater/expo";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";
import { localSigning } from "hot-updater/signing";

config({ path: ".env.hotupdater" });

export default defineConfig({
  build: expo(),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
  }),
  updateStrategy: "appVersion",
  compressStrategy: "zip", // or "tar.br" for better compression
  fingerprint: {
    debug: true,
  },
  // Bundle signing is enabled for this example.
  // Run: npx hot-updater keys generate
  signing: localSigning({
    privateKeyPath: "./keys/private-key.pem",
  }),
});
