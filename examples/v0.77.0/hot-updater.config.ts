
import { metro } from "@hot-updater/metro";
import { firebaseStorage, firebaseDatabase } from "@hot-updater/firebase";
import { defineConfig } from "hot-updater";
import "dotenv/config";

export default defineConfig({
  build: metro({ enableHermes: true }),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: firebaseDatabase({
    apiKey: process.env.HOT_UPDATER_FIREBASE_API_KEY,
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
  }),
});
