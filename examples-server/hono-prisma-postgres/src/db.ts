import { s3Storage } from "@hot-updater/aws";
import { createHotUpdater } from "@hot-updater/server";
import { prismaAdapter } from "@hot-updater/server/adapters/prisma";
import { insights } from "@hot-updater/server/plugins";

import { prisma } from "./prisma";

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: prismaAdapter({
    prisma,
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
        }),
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
      channels,
      bundle_totals
    CASCADE
  `);
}
