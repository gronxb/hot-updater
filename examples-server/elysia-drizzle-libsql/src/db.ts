import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { drizzleAdapter } from "@hot-updater/server/adapters/drizzle";

import { client, db } from "./drizzle";

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: drizzleAdapter({
    db,
    provider: "sqlite",
  }),
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
  clientBasePath: "/hot-updater",
  features: {
    updateCheck: true,
    analytics: true,
  },
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {}

export async function resetDecisionFixtures() {
  await client.batch(
    [
      "DELETE FROM bundle_patches",
      "DELETE FROM release_catalogs",
      "DELETE FROM releases",
      "DELETE FROM bundles",
      "DELETE FROM channels",
    ],
    "write",
  );
}
