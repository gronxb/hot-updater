import path from "path";

import { r2Storage } from "@hot-updater/cloudflare";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { mongoAdapter } from "@hot-updater/server/adapters/mongodb";
import { config } from "dotenv";

import { client, closeDatabase as closeMongo, db } from "./mongodb";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
config({ path: path.join(__dirname, ".env.hotupdater") });

// Create Hot Updater instance for CLI
// Note: MongoDB connection must be established before using this instance
export const hotUpdater = createHotUpdater({
  database: mongoAdapter({
    client,
    transactions: true,
  }),
  storage: [
    mockStorage({}),
    r2Storage({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
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
  basePath: "/hot-updater",
  features: {
    updateCheck: true,
    bundles: true,
    analytics: { queryAccess: "public" },
  },
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await closeMongo();
}

export async function resetDecisionFixtures() {
  await Promise.all(
    [
      "bundle_patches",
      "release_catalogs",
      "releases",
      "bundles",
      "channels",
    ].map((collection) => db.collection(collection).deleteMany({})),
  );
}
