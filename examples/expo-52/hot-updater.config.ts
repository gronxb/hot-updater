import { expo } from "@hot-updater/expo";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

export default defineConfig({
  build: expo(),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    connectionString: process.env.HOT_UPDATER_SUPABASE_DATABASE_URL!,
  }),
  updateStrategy: "appVersion",
  compressStrategy: "zip", // or "tar.br" for better compression
  fingerprint: {
    debug: true,
  },
  // Bundle signing (optional)
  // Uncomment to enable signed bundles for security
  // Run: npx hot-updater keys generate
  signing: {
    enabled: true,
    privateKeyPath: "./keys/private-key.pem",
  },
});
