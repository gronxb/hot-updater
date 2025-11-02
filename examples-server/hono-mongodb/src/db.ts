import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { mongodbAdapter } from "@hot-updater/server/adapters/mongodb";
import { db, closeDatabase as closeMongo } from "./mongodb";

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: mongodbAdapter({
    db,
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
  ],
  basePath: "/hot-updater",
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await closeMongo();
}
