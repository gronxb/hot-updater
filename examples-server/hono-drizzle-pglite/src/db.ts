import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { drizzleDatabase } from "@hot-updater/server/adapters/drizzle";

import { closeClient, getDB, schema } from "./drizzle";

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: drizzleDatabase({
    db: getDB,
    provider: "postgresql",
    schema,
  }),
  storages: [
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
  routes: {
    updateCheck: true,
    bundles: true,
  },
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await closeClient();
}
