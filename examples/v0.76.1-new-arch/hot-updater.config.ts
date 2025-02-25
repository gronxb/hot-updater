import { metro } from "@hot-updater/metro";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { defineConfig } from "hot-updater";
import "dotenv/config";

export default defineConfig({
  appName: "hot-updater-v0.76.1-new-arch",
  build: metro({
    enableHermes: true,
  }),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
  }),
});
