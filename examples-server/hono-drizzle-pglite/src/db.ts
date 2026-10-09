import { s3Storage } from "@hot-updater/aws";
import { createHotUpdater } from "@hot-updater/server";
import { drizzleAdapter } from "@hot-updater/server/adapters/drizzle";
import { insights } from "@hot-updater/server/plugins";

import { closeClient, getDB, resetDecisionFixtures } from "./drizzle";

export { resetDecisionFixtures };

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: drizzleAdapter({
    db: getDB,
    provider: "postgresql",
  }),
  plugins: [insights()],
  clientAccess: "public",
  storage:
    process.env.NODE_ENV === "test"
      ? (
          await import("@hot-updater/test-utils/node")
        ).createReleaseCatalogTestStorage()
      : s3Storage({
          region: "auto",
          endpoint: process.env.R2_ENDPOINT,
          credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID!,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
          },
          bucketName: process.env.R2_BUCKET_NAME!,
          downloadUrlSigningKey:
            process.env.HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY ??
            "development-storage-download-url-key",
        }),
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await closeClient();
}
