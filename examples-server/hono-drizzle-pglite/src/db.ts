import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { drizzleAdapter } from "@hot-updater/server/adapters/drizzle";

import { closeClient, getDB, resetDecisionFixtures, schema } from "./drizzle";

export { resetDecisionFixtures };

const insightsDatabaseNamespace =
  process.env.HOT_UPDATER_INSIGHTS_DATABASE_NAMESPACE ??
  "00000000-0000-7000-8000-00000000e001";

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: drizzleAdapter({
    db: getDB,
    insightsDatabaseNamespace,
    provider: "postgresql",
    schema,
    transaction: true,
  }),
  clientAccess: { type: "public" },
  storage: [
    mockStorage({}),
    s3Storage({
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
  ],
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await closeClient();
}
