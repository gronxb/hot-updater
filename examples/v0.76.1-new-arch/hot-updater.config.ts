import { bare } from "@hot-updater/bare";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

export default defineConfig({
  build: bare({
    enableHermes: true,
  }),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    connectionString: process.env.HOT_UPDATER_SUPABASE_DATABASE_URL!,
  }),
  updateStrategy: "fingerprint",
  compressStrategy: "zip", // or "tar.br" for better compression
});
