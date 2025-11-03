import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import type { HotUpdaterAPI } from "@hot-updater/server";
import { mongoAdapter } from "@hot-updater/server/adapters/mongodb";
import { client, closeDatabase as closeMongo } from "./mongodb";

let hotUpdaterInstance: HotUpdaterAPI | null = null;

// Factory function to create Hot Updater API after MongoDB is connected
export function createHotUpdaterInstance(): HotUpdaterAPI {
  if (!hotUpdaterInstance) {
    hotUpdaterInstance = createHotUpdater({
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
      ],
      basePath: "/hot-updater",
    });
  }
  return hotUpdaterInstance;
}

// Get the initialized Hot Updater instance
export function getHotUpdater(): HotUpdaterAPI {
  if (!hotUpdaterInstance) {
    throw new Error(
      "Hot Updater not initialized. Call createHotUpdaterInstance() first.",
    );
  }
  return hotUpdaterInstance;
}

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await closeMongo();
}
