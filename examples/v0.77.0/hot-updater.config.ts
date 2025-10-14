import "dotenv/config";
import { bare } from "@hot-updater/bare";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

export default defineConfig({
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
        scheme: "HotUpdaterExample",
        configuration: "Release",
        archive: false,
        installPods: true,
        exportOptionsPlist: "./ios/HotUpdaterExample/ExportOptions.plist",
      },
      // debug: {
      //   scheme: "Debug",
      //   exportOptionsPlist: "./ios/HotUpdaterExample/ExportOptions.plist",
      // },
    },
  },
  build: bare({ enableHermes: true }),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
  }),
  updateStrategy: "fingerprint",
});
