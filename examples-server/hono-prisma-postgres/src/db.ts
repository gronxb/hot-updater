import { r2Storage } from "@hot-updater/cloudflare";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { prismaAdapter } from "@hot-updater/server/adapters/prisma";

import { prisma } from "./prisma";

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: prismaAdapter({
    prisma,
    provider: "postgresql",
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
  },
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await prisma.$disconnect();
}

export async function resetDecisionFixtures() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      bundle_patches,
      release_catalogs,
      releases,
      bundles,
      channels
    CASCADE
  `);
}
