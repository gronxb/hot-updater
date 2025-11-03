import { s3Storage } from "@hot-updater/aws";
import { r2Storage } from "@hot-updater/cloudflare";
// import { firebaseStorage } from "@hot-updater/firebase";
import { supabaseStorage } from "@hot-updater/supabase";

// import admin from "fZrebase-admin";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { mongoAdapter } from "@hot-updater/server/adapters/mongodb";
import { client, closeDatabase as closeMongo } from "./mongodb";
import path from "path";
import { config } from "dotenv";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
config({ path: path.join(__dirname, ".env.hotupdater") });

// Create Hot Updater instance for CLI
// Note: MongoDB connection must be established before using this instance
export const hotUpdater = createHotUpdater({
  database: mongoAdapter({
    client,
  }),
  storagePlugins: [
    mockStorage({}),
    s3Storage({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      bucketName: process.env.R2_BUCKET_NAME!,
    }),
    r2Storage({
      bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
      accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
      cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
    }),
    // firebaseStorage({
    //   projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    //   storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
    //   credential: admin.credential.applicationDefault(),
    // }),
    supabaseStorage({
      supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
      supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
      bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
    }),
  ],
  basePath: "/hot-updater",
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await closeMongo();
}
