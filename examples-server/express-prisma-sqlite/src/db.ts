import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { prismaAdapter } from "@hot-updater/server/adapters/prisma";

import { prisma } from "./prisma";

const insightsDatabaseNamespace =
  process.env.HOT_UPDATER_INSIGHTS_DATABASE_NAMESPACE ??
  "00000000-0000-7000-8000-00000000e001";

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: prismaAdapter({
    insightsDatabaseNamespace,
    prisma,
    provider: "sqlite",
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
  await prisma.$disconnect();
}

export async function resetDecisionFixtures() {
  await prisma.$transaction([
    prisma.bundle_patches.deleteMany(),
    prisma.release_catalogs.deleteMany(),
    prisma.releases.deleteMany(),
    prisma.bundles.deleteMany(),
    prisma.channels.deleteMany(),
  ]);
}
